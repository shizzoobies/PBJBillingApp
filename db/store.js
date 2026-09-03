import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile as fsWriteFile } from 'node:fs/promises'
import { classifySplitTarget } from '../lib/group-allocation.js'
import { inactiveClientIds, isInactiveClientStage } from '../lib/recurring-gate.js'
import {
  CHECKLIST_INSTANCE_UNIQUE_INDEX,
  buildChecklistInstanceKeys,
  checklistInstanceKey,
  checklistMonthKey,
  findChecklistInstance,
} from '../lib/checklist-identity.js'
import { decryptSecretAtRest, encryptSecretAtRest } from '../lib/totp.js'
import { isWaitingOnOpen, waitingOnStage } from '../lib/waiting-on-state.js'
import { mergeContactIds, planPrimaryContact } from '../lib/primary-contact.js'
import {
  buildConsolidatedInvoiceDraft,
  buildInvoiceDraft,
  dueDateFromTerms,
  nextInvoiceNumber,
  nextRetainerInvoiceNumber,
  previousPeriod,
} from '../lib/invoice-draft.js'
import {
  StaleWorkspaceError,
  fileWorkspaceVersion,
  postgresWorkspaceVersion,
} from '../lib/workspace-version.js'
import {
  periodLabelForInstance,
  sanitizeCoverageDate,
  sanitizePeriodLabel,
} from '../lib/checklist-period-label.js'
import {
  RETAINER_LABEL,
  invoiceLockRefusal,
  normalizeAdhocMode,
  normalizeTimeBreakdownMode,
  retainerCreditAmount,
} from '../lib/invoice-lines.js'
import {
  anchorDayFromRange,
  anchorDayOf,
  coverageLineLabel,
  hasUnconfirmedCoverage,
  isIsoDate,
  normalizeRecurringReimbursement,
} from '../lib/expense-coverage.js'

/**
 * Per-file operation queue for the JSON file backend. A plain
 * fsWriteFile truncates the target before writing, so a concurrent
 * readFile (every request reads these files fresh) could observe an
 * empty or half-written file and crash with "Unexpected end of JSON
 * input". Atomic rename is not an option here — Windows refuses to
 * rename over a file another handle has open. Instead, all reads and
 * writes to the same path are chained onto one promise queue, so a read
 * can never overlap a write in this process. Production (Postgres)
 * never touches this path.
 */
const fileOperationQueues = new Map()
function enqueueFileOperation(filePath, operation) {
  const tail = fileOperationQueues.get(filePath) ?? Promise.resolve()
  const run = tail.then(operation, operation)
  // The stored tail must never be a rejected promise: an op that throws (the
  // staleness guard refusing a save) would otherwise surface as an unhandled
  // rejection once no further op chains behind it. The caller still receives
  // the real rejection via `run`; the queue itself only needs settlement order.
  const tracked = run.then(
    () => {},
    () => {},
  ).finally(() => {
    if (fileOperationQueues.get(filePath) === tracked) {
      fileOperationQueues.delete(filePath)
    }
  })
  fileOperationQueues.set(filePath, tracked)
  return run
}

/**
 * Shadows the fs/promises name on purpose so every existing
 * writeFile(localDataPath/localAuthPath, …) call site is serialized.
 */
function writeFile(filePath, content) {
  return enqueueFileOperation(filePath, () => fsWriteFile(filePath, content))
}
import path from 'node:path'
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const { Pool } = pg

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.dirname(__dirname)
const seedDataPath = path.join(projectRoot, 'prototype-data.json')
const localDataPath = path.join(projectRoot, 'tmp', 'app-data.json')
const localAuthPath = path.join(projectRoot, 'tmp', 'auth-state.json')
const sessionTtlMs = 1000 * 60 * 60 * 24 * 7

// Seed columns for the Active Checklists board, created once when the
// service_categories store is empty (matches the client's sketch). Order here
// is the initial left-to-right column order; the owner can rename/reorder/add.
const SEED_SERVICE_CATEGORIES = [
  'Monthly Bookkeeping',
  'Quarterly Bookkeeping',
  'Sales Tax',
  'Payroll',
]

const demoPassword = process.env.AUTH_DEMO_PASSWORD || 'pbj-demo'

const DEFAULT_FIRM_SETTINGS = {
  name: 'PB&J Strategic Accounting',
  tagline: '',
  logoUrl: '',
  brandColor: '#3c2044',
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  postalCode: '',
  phone: '',
  email: '',
  website: '',
  ein: '',
}

const FIRM_SETTINGS_FIELDS = [
  ['name', 'name'],
  ['tagline', 'tagline'],
  ['logoUrl', 'logo_url'],
  ['brandColor', 'brand_color'],
  ['sidebarTextColor', 'sidebar_text_color'],
  ['sidebarActiveTextColor', 'sidebar_active_text_color'],
  ['addressLine1', 'address_line1'],
  ['addressLine2', 'address_line2'],
  ['city', 'city'],
  ['state', 'state'],
  ['postalCode', 'postal_code'],
  ['phone', 'phone'],
  ['email', 'email'],
  ['website', 'website'],
  ['ein', 'ein'],
]

function rowToFirmSettings(row) {
  if (!row) return { ...DEFAULT_FIRM_SETTINGS }
  const settings = { ...DEFAULT_FIRM_SETTINGS }
  for (const [appKey, dbCol] of FIRM_SETTINGS_FIELDS) {
    if (row[dbCol] !== null && row[dbCol] !== undefined) {
      settings[appKey] = row[dbCol]
    }
  }
  if (row.client_defaults !== null && row.client_defaults !== undefined) {
    // jsonb comes back parsed from pg; tolerate a string just in case.
    const raw =
      typeof row.client_defaults === 'string'
        ? safeJsonParse(row.client_defaults)
        : row.client_defaults
    settings.clientDefaults = {
      ...DEFAULT_FIRM_SETTINGS.clientDefaults,
      ...sanitizeClientDefaults(raw),
    }
  }
  return settings
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

/**
 * Normalize the stored work-sessions for a time entry into a clean array of
 * { startAt, endAt } ISO pairs. jsonb comes back already parsed from pg; we
 * tolerate a string just in case. When there are no stored sessions but the
 * row has the legacy envelope columns (started_at/ended_at), synthesize a
 * single session so older entries display + edit consistently.
 */
function normalizeStoredSessions(rawSessions, startedAt, endedAt) {
  let list = rawSessions
  if (typeof list === 'string') {
    const parsed = safeJsonParse(list)
    list = Array.isArray(parsed) ? parsed : []
  }
  if (Array.isArray(list)) {
    const clean = list
      .filter((s) => s && typeof s.startAt === 'string' && typeof s.endAt === 'string')
      .map((s) => ({ startAt: s.startAt, endAt: s.endAt }))
    if (clean.length > 0) return clean
  }
  if (startedAt && endedAt) {
    return [{ startAt: startedAt.toISOString(), endAt: endedAt.toISOString() }]
  }
  return []
}

const VALID_BILLING_MODES = new Set(['hourly', 'subscription', 'annual'])

// 4-level priority for the owner-only "Updates" tracker. Items group by level
// first (Urgent → Low), then by drag-rank within a level. The SQL CASE mirrors
// PRIORITY_WEIGHT for the listFeatureRequests ORDER BY.
const FEATURE_REQUEST_PRIORITIES = ['urgent', 'high', 'medium', 'low']
const FEATURE_REQUEST_PRIORITY_WEIGHT_SQL =
  `case priority when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end`
const FEATURE_REQUEST_PRIORITY_WEIGHT = { urgent: 0, high: 1, medium: 2, low: 3 }

/**
 * Validate the owner-configured new-client defaults. Every field is optional;
 * only well-typed values survive so a crafted payload can't poison the
 * Add-client form (numbers clamp to [0, 1e9], strings are length-capped,
 * billing mode is enum-checked, toggles must be real booleans).
 */
function sanitizeClientDefaults(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  const toMoney = (v) => {
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) return undefined
    return Math.min(n, 1e9)
  }
  if (VALID_BILLING_MODES.has(src.billingMode)) out.billingMode = src.billingMode
  const hourly = toMoney(src.hourlyRate)
  if (hourly !== undefined) out.hourlyRate = hourly
  const monthly = toMoney(src.monthlyRate)
  if (monthly !== undefined) out.monthlyRate = monthly
  if (typeof src.paymentTerms === 'string') out.paymentTerms = src.paymentTerms.slice(0, 500)
  if (typeof src.footerNote === 'string') out.footerNote = src.footerNote.slice(0, 2000)
  if (typeof src.invoiceShowTimeBreakdown === 'boolean') {
    out.invoiceShowTimeBreakdown = src.invoiceShowTimeBreakdown
  }
  if (typeof src.invoiceTimeBreakdownMode === 'string') {
    out.invoiceTimeBreakdownMode = normalizeTimeBreakdownMode(src.invoiceTimeBreakdownMode)
  }
  if (typeof src.invoiceTimeBreakdownAmounts === 'boolean') {
    out.invoiceTimeBreakdownAmounts = src.invoiceTimeBreakdownAmounts
  }
  if (typeof src.invoiceHideInternalHours === 'boolean') {
    out.invoiceHideInternalHours = src.invoiceHideInternalHours
  }
  if (typeof src.invoiceGroupByCategory === 'boolean') {
    out.invoiceGroupByCategory = src.invoiceGroupByCategory
  }
  return out
}

const seededUsers = [
  {
    id: 'emp-patrice',
    name: 'Brittany Ferguson',
    email: 'brittany-ferguson@pbj.local',
    staffRole: 'Owner',
    role: 'owner',
  },
  {
    id: 'emp-avery',
    name: 'Avery Johnson',
    email: 'avery@pbj.local',
    staffRole: 'Accountant',
    role: 'senior_bookkeeper',
  },
  {
    id: 'emp-jordan',
    name: 'Jordan Ellis',
    email: 'jordan@pbj.local',
    staffRole: 'Bookkeeper',
    role: 'bookkeeper',
  },
]

function readJson(filePath) {
  return enqueueFileOperation(filePath, async () =>
    JSON.parse(await readFile(filePath, 'utf8')),
  )
}

function hashPassword(password, salt = randomUUID()) {
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password, storedHash) {
  const [salt, expectedHex] = storedHash.split(':')
  if (!salt || !expectedHex) {
    return false
  }

  const actualBuffer = scryptSync(password, salt, 64)
  const expectedBuffer = Buffer.from(expectedHex, 'hex')
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

function mapSessionUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role === 'owner' ? 'owner' : 'employee',
    staffRole: user.staffRole,
  }
}

function generateMagicToken() {
  return randomBytes(32).toString('base64url')
}

function nowIso() {
  return new Date().toISOString()
}

function createSeededAuthUsers() {
  const createdAt = nowIso()
  return seededUsers.map((user) => ({
    ...user,
    passwordHash: hashPassword(demoPassword),
    magicToken: generateMagicToken(),
    tokenRevokedAt: null,
    lastActiveAt: null,
    createdAt,
  }))
}

function roleToDbRole(role) {
  if (role === 'Owner') {
    return 'owner'
  }

  // 'Senior Bookkeeper' is the legacy label for the 'Accountant' staff role;
  // still accepted so stale callers map to the same DB value.
  if (role === 'Accountant' || role === 'Senior Bookkeeper') {
    return 'senior_bookkeeper'
  }

  return 'bookkeeper'
}

function dbRoleToEmployeeRole(role) {
  if (role === 'owner') {
    return 'Owner'
  }

  // DB value 'senior_bookkeeper' is the legacy identifier for 'Accountant'.
  if (role === 'senior_bookkeeper') {
    return 'Accountant'
  }

  return 'Bookkeeper'
}

function formatDateOnly(date) {
  return date.toISOString().slice(0, 10)
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T12:00:00`)
  date.setDate(date.getDate() + days)
  return formatDateOnly(date)
}

function addMonths(dateString, months) {
  const [year, month, day] = dateString.split('-').map(Number)
  const date = new Date(year, month - 1 + months, day)
  return formatDateOnly(date)
}

function advanceChecklistFrequency(dateString, frequency) {
  if (frequency === 'daily') {
    return addDays(dateString, 1)
  }

  if (frequency === 'weekly') {
    return addDays(dateString, 7)
  }

  if (frequency === 'biweekly') {
    return addDays(dateString, 14)
  }

  if (frequency === 'quarterly') {
    return addMonths(dateString, 3)
  }

  if (frequency === 'annually') {
    return addMonths(dateString, 12)
  }

  return addMonths(dateString, 1)
}

// Server-side guard for user-supplied URLs (e.g. a client's QuickBooks pay
// link). Mirrors `isSafeHttpUrl` in src/lib/utils.ts — only absolute http(s)
// URLs survive, so a `javascript:`/`data:` value never reaches the DB even via
// a direct API write.
function isSafeHttpUrl(value) {
  if (!value || typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * Per-role estimated hours, with legacy fallback. Returns the three role-hour
 * fields to spread onto a client. If all three new role fields are absent but
 * the legacy `estimatedMonthlyHours` is set, surface it as
 * `estimatedBookkeeperHours` so existing clients' numbers aren't lost and the
 * total isn't 0. Shared by the Postgres read-map and `normalizeClientProfile`.
 */
function mapEstimatedRoleHours({ legacy, bookkeeper, accountant, cfo }) {
  const num = (value) =>
    value === null || value === undefined || Number.isNaN(Number(value))
      ? undefined
      : Number(value)
  const bk = num(bookkeeper)
  const ac = num(accountant)
  const cf = num(cfo)
  const lg = num(legacy)
  const allRolesAbsent = bk === undefined && ac === undefined && cf === undefined
  const out = {}
  if (bk !== undefined) out.estimatedBookkeeperHours = bk
  else if (allRolesAbsent && lg !== undefined) out.estimatedBookkeeperHours = lg
  if (ac !== undefined) out.estimatedAccountantHours = ac
  if (cf !== undefined) out.estimatedCfoHours = cf
  return out
}

/**
 * Every lifecycle stage a client may legitimately hold. 'inactive' is the
 * retirement stage: it is a real, persisted value (a retired client keeps all
 * of their history), it is just never reachable from the stage dropdown — only
 * from the explicit Mark inactive / Reactivate actions.
 */
export const LIFECYCLE_STAGES = ['proposal', 'onboarding', 'active', 'inactive']

/**
 * Clamp a lifecycle stage to a value the column and the UI both understand.
 * Absent or garbage becomes 'active': a client saved without the field (legacy
 * payload, older client build) must never silently become a prospect — or, now,
 * silently disappear from every picker in the app.
 *
 * ONE copy, because three write paths set this column and a stage only one of
 * them accepts is a stage that flips back on the next save.
 */
export function coerceLifecycleStage(stage) {
  return LIFECYCLE_STAGES.includes(stage) ? stage : 'active'
}

export function normalizeClientProfile(client) {
  // Billing refactor back-compat. Surface `planIds`/`contactIds` as arrays
  // (never undefined) and derive `monthlyRate` from the legacy
  // `customMonthlyFee` when the new field is absent — mirrors the Postgres
  // read-map so the file-fallback path produces identical shapes.
  const planIdsRaw = Array.isArray(client.planIds)
    ? client.planIds.filter((id) => typeof id === 'string' && id)
    : []
  const planIds =
    planIdsRaw.length > 0 ? planIdsRaw : client.planId ? [client.planId] : []
  const contactIds = Array.isArray(client.contactIds)
    ? client.contactIds.filter((id) => typeof id === 'string' && id)
    : []
  const monthlyRate =
    typeof client.monthlyRate === 'number' && !Number.isNaN(client.monthlyRate)
      ? client.monthlyRate
      : typeof client.customMonthlyFee === 'number' && !Number.isNaN(client.customMonthlyFee)
        ? client.customMonthlyFee
        : undefined
  // One assigned team — see lib/data-scope.js. `assignedEmployeeIds` is an
  // alias; whatever a caller passed under that name is discarded here so the
  // old field cannot become a second source of truth again.
  const assignedTeam = Array.isArray(client.assignedBookkeeperIds)
    ? [...new Set(client.assignedBookkeeperIds.filter((id) => typeof id === 'string'))]
    : []
  return {
    ...client,
    planIds,
    contactIds,
    ...(monthlyRate === undefined ? {} : { monthlyRate }),
    ...mapEstimatedRoleHours({
      legacy: client.estimatedMonthlyHours,
      bookkeeper: client.estimatedBookkeeperHours,
      accountant: client.estimatedAccountantHours,
      cfo: client.estimatedCfoHours,
    }),
    assignedBookkeeperIds: assignedTeam,
    assignedEmployeeIds: assignedTeam,
    email: client.email ?? '',
    contactName: client.contactName ?? '',
    phone: client.phone ?? '',
    addressLine1: client.addressLine1 ?? '',
    addressLine2: client.addressLine2 ?? '',
    city: client.city ?? '',
    state: client.state ?? '',
    postalCode: client.postalCode ?? '',
    logoUrl: client.logoUrl ?? '',
    paymentTerms: client.paymentTerms ?? '',
    footerNote: client.footerNote ?? '',
    // Reject non-http(s) pay URLs (e.g. `javascript:`) so a bad value never
    // persists — the invoice screen renders this as a live `<a href>`.
    quickbooksPayUrl: isSafeHttpUrl(client.quickbooksPayUrl) ? client.quickbooksPayUrl : '',
    invoiceShowTimeBreakdown:
      typeof client.invoiceShowTimeBreakdown === 'boolean' ? client.invoiceShowTimeBreakdown : true,
    // Off unless chosen — an unrecognized value is off too, so a bad payload
    // can never start printing a client's hours.
    invoiceTimeBreakdownMode: normalizeTimeBreakdownMode(client.invoiceTimeBreakdownMode),
    invoiceTimeBreakdownAmounts: client.invoiceTimeBreakdownAmounts === true,
    invoiceHideInternalHours:
      typeof client.invoiceHideInternalHours === 'boolean' ? client.invoiceHideInternalHours : true,
    invoiceGroupByCategory:
      typeof client.invoiceGroupByCategory === 'boolean' ? client.invoiceGroupByCategory : false,
    // Card payments are OFF unless a person switched them on. Bank transfer is
    // the no-fee default for everyone, and a client who never agreed to cover a
    // processing fee must never be offered one by accident.
    cardPaymentsEnabled:
      typeof client.cardPaymentsEnabled === 'boolean' ? client.cardPaymentsEnabled : false,
    // Consolidated billing (featreq-65f5eac1). `billToClientId` names the
    // BILLING MASTER this client's work is invoiced on; `isBillingMaster` marks
    // that payer row itself; `invoiceRecipientClientId` is the sub whose
    // contacts receive the master's invoice ("sends invoice to sub client you
    // choose"). Null on all three is the ordinary client: its own invoice, its
    // own contacts. Read here as well as on the Postgres row map so the two
    // backends hand back the same shape — cardinal rule 1.
    billToClientId:
      typeof client.billToClientId === 'string' && client.billToClientId
        ? client.billToClientId
        : null,
    isBillingMaster: client.isBillingMaster === true,
    invoiceRecipientClientId:
      typeof client.invoiceRecipientClientId === 'string' && client.invoiceRecipientClientId
        ? client.invoiceRecipientClientId
        : null,
  }
}

function sortChecklists(checklists) {
  return [...checklists].sort((left, right) => {
    if (left.dueDate !== right.dueDate) {
      return left.dueDate.localeCompare(right.dueDate)
    }

    return left.title.localeCompare(right.title)
  })
}

/**
 * Migrate a template that may still carry a flat `items` array into one that
 * has a `stages` array. Idempotent. The legacy top-level
 * assigneeId/viewerIds/editorIds become Stage 1's defaults so existing
 * pre-Phase-3 templates show up as a single stage the owner can rename or
 * extend. Forward-only chain: there is no send-back from later stages.
 */
function ensureTemplateStages(template) {
  const viewerIds = Array.isArray(template.viewerIds) ? [...template.viewerIds] : []
  const editorIds = Array.isArray(template.editorIds) ? [...template.editorIds] : []
  const existingStages = Array.isArray(template.stages) ? template.stages : null
  if (existingStages && existingStages.length > 0) {
    const stages = existingStages.map((stage, index) => ({
      id: stage.id || `stage-${randomUUID().slice(0, 8)}`,
      name: stage.name || `Stage ${index + 1}`,
      assigneeId: stage.assigneeId || template.assigneeId,
      offsetDays: Number.isFinite(Number(stage.offsetDays)) ? Number(stage.offsetDays) : 0,
      ...(stage.dueDate ? { dueDate: stage.dueDate } : {}),
      // Carry the recurring day-of-month spec — without this, picking "Day of
      // the month" on a stage was silently dropped on save (the field never
      // survived this normalizer), so the due date reverted to "none".
      ...(typeof stage.dueDayOfMonth === 'number' && stage.dueDayOfMonth >= 1
        ? { dueDayOfMonth: stage.dueDayOfMonth }
        : {}),
      viewerIds: Array.isArray(stage.viewerIds) ? [...stage.viewerIds] : [],
      editorIds: Array.isArray(stage.editorIds) ? [...stage.editorIds] : [],
      items: Array.isArray(stage.items) ? stage.items.map((item) => ({ ...item })) : [],
    }))
    return { ...template, viewerIds, editorIds, stages }
  }

  const flatItems = Array.isArray(template.items) ? template.items.map((item) => ({ ...item })) : []
  const stage = {
    id: `stage-${randomUUID().slice(0, 8)}`,
    name: 'Stage 1',
    assigneeId: template.assigneeId,
    offsetDays: 0,
    viewerIds,
    editorIds,
    items: flatItems,
  }
  return { ...template, viewerIds, editorIds, stages: [stage] }
}

/**
 * The Nth day of `baseDate`'s month as an ISO yyyy-mm-dd, with `day` clamped to
 * the month's real length (so "31" lands on Feb 28/29). Mirrors the helper in
 * src/lib/utils.ts.
 */
/**
 * Time-entry patch fields where an empty value means "no value" and must be
 * written as SQL NULL. `clientId` is the critical one: switching an entry to
 * administrative time clears its client, and the `time_entries.client_id` FK
 * rejects '' — it has to be NULL (matching the create path's `clientId || null`).
 */
const NULLABLE_TIME_ENTRY_FIELDS = new Set([
  'clientId',
  'taskId',
  'approvalNote',
  'approvedBy',
  'approvedAt',
  'startAt',
  'endAt',
])

/** Coerce one time-entry patch value for persistence (see the set above). */
export function coerceTimeEntryPatchValue(key, value) {
  if (NULLABLE_TIME_ENTRY_FIELDS.has(key) && (value === '' || value === undefined)) {
    return null
  }
  return value
}

function dayOfMonthDate(baseDate, day) {
  const [year, month] = baseDate.split('-').map(Number)
  const lastDay = new Date(year, month, 0).getDate()
  const clamped = Math.min(Math.max(Math.trunc(day), 1), lastDay)
  return `${year}-${String(month).padStart(2, '0')}-${String(clamped).padStart(2, '0')}`
}

/**
 * Resolve a stage's due date. Precedence: an explicit fixed `stage.dueDate`
 * always wins; else a recurring `stage.dueDayOfMonth` resolves to that day of
 * `baseDate`'s month (clamped to the month's length); else the LEGACY
 * `offsetDays` — kept for back-compat — counts days BEFORE the deadline so a
 * hand-off stage lands on or before the task's due date; else `baseDate`.
 * Note: per-stage *repeat cadence* is not supported — the template repeats as a
 * whole; only the due date can be per-stage. Mirrors src/lib/utils.ts.
 */
function resolveStageDueDate(stage, baseDate) {
  if (stage && stage.dueDate) {
    return stage.dueDate
  }
  if (stage && typeof stage.dueDayOfMonth === 'number' && stage.dueDayOfMonth >= 1) {
    return dayOfMonthDate(baseDate, stage.dueDayOfMonth)
  }
  const offset = Number(stage && stage.offsetDays) || 0
  return offset ? addDays(baseDate, -offset) : baseDate
}

/**
 * Resolve a checklist NODE's (item / sub-item / sub-sub-item) concrete due date
 * for a given cycle month. Precedence: a fixed `node.dueDate` wins; else a
 * recurring `node.dueDayOfMonth` resolves to that day of `cycleYear`/
 * `cycleMonth` (1–12), clamped to the month's length; else `undefined`.
 * Mirrors src/lib/utils.ts.
 */
function resolveNodeDueDate(node, cycleYear, cycleMonth) {
  if (node && node.dueDate) {
    return node.dueDate
  }
  if (node && typeof node.dueDayOfMonth === 'number' && node.dueDayOfMonth >= 1) {
    const lastDay = new Date(cycleYear, cycleMonth, 0).getDate()
    const day = Math.min(Math.trunc(node.dueDayOfMonth), lastDay)
    return `${cycleYear}-${String(cycleMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  return undefined
}

/**
 * Concrete due date a specific-months template's checklist gets in `month` of
 * `year`. Prefers the per-month `monthlyDueDays` entry, falls back to the legacy
 * shared `dueDayOfMonth`, then to the last day of the month. The chosen day is
 * clamped to the month's real length (so "31" lands on Feb 28/29). `month` is
 * 1–12. The returned date always stays inside `month`, which keeps the
 * materializer's per-month idempotency key valid.
 */
function resolveSpecificMonthsDueDate(template, year, month) {
  const lastDay = new Date(year, month, 0).getDate()
  const perMonth = template.monthlyDueDays ? Number(template.monthlyDueDays[month]) : NaN
  const legacy = typeof template.dueDayOfMonth === 'number' ? template.dueDayOfMonth : NaN
  const requested = Number.isFinite(perMonth) && perMonth >= 1 ? perMonth : legacy
  const day = Number.isFinite(requested) && requested >= 1 ? Math.min(requested, lastDay) : lastDay
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Due date for the FIRST stage of a specific-months case instance. Honors that
 * stage's own `dueDayOfMonth` (resolved inside the designated `month`, so it
 * stays in-month) — matching how every LATER stage honors its own day via
 * `resolveStageDueDate` — and falls back to the template's per-month / shared
 * due day when stage 1 has none. A fixed stage `dueDate` and the legacy
 * `offsetDays` are intentionally NOT applied here: either could push the
 * instance out of its designated month and break the per-month idempotency key.
 * Mirrors src/lib/utils.ts resolveSpecificMonthsStageDueDate.
 */
function resolveSpecificMonthsStageDueDate(template, stage, year, month) {
  if (stage && typeof stage.dueDayOfMonth === 'number' && stage.dueDayOfMonth >= 1) {
    const lastDay = new Date(year, month, 0).getDate()
    const day = Math.min(Math.trunc(stage.dueDayOfMonth), lastDay)
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  return resolveSpecificMonthsDueDate(template, year, month)
}

/**
 * Normalize a raw sub-sub-items value (deepest level) into a clean
 * `{ id, title, done }[]`. Drops malformed entries. Sub-sub-items never nest
 * further. `withDone` controls whether `done` is included.
 */
/**
 * Normalize a raw "waiting on a person" list into a clean
 * `{ id, blockerId, requestedBy, note?, createdAt }[]`, plus the optional
 * hand-off fields (`blockerType`, `resolvedAt/By`, `verifiedAt/By` — see
 * `lib/waiting-on-state.js`). Drops malformed entries (any missing a
 * blockerId/requestedBy). Defaults to `[]`. Used on every node (item + sub +
 * sub-sub) so structured blockers survive the JSONB / file round-trip.
 *
 * A client wait still carries a `blockerId` — the server fills it in from the
 * checklist's own client — so the drop rule below needs no exception.
 */
export function normalizeWaitingOns(raw) {
  const list = Array.isArray(raw) ? raw : []
  return list
    .filter(
      (entry) =>
        entry &&
        typeof entry.blockerId === 'string' &&
        entry.blockerId &&
        typeof entry.requestedBy === 'string' &&
        entry.requestedBy,
    )
    .map((entry) => {
      const base = {
        id:
          typeof entry.id === 'string' && entry.id
            ? entry.id
            : `wo-${randomUUID().slice(0, 8)}`,
        blockerId: entry.blockerId,
        requestedBy: entry.requestedBy,
        createdAt:
          typeof entry.createdAt === 'string' && entry.createdAt
            ? entry.createdAt
            : nowIso(),
      }
      if (typeof entry.note === 'string' && entry.note.trim()) {
        base.note = entry.note.trim()
      }
      if (entry.blockerType === 'client') {
        base.blockerType = 'client'
      }
      // Carried through verbatim; absent means that stage hasn't happened yet.
      for (const field of ['resolvedAt', 'resolvedBy', 'verifiedAt', 'verifiedBy']) {
        if (typeof entry[field] === 'string' && entry[field]) {
          base[field] = entry[field]
        }
      }
      // Send-back history, in order. This list is the reason a rejected wait
      // loses nothing: the resolution it cleared is stashed here alongside the
      // requester's new note, so "who did it and when" survives every lap and
      // the ORIGINAL note above is never overwritten. Every read re-normalizes,
      // so dropping this here would silently erase the history on the next load.
      if (Array.isArray(entry.sendBacks)) {
        const events = entry.sendBacks
          .filter(
            (event) =>
              event &&
              typeof event.at === 'string' &&
              event.at &&
              typeof event.by === 'string' &&
              event.by,
          )
          .map((event) => {
            const stamped = { at: event.at, by: event.by }
            if (typeof event.note === 'string' && event.note.trim()) {
              stamped.note = event.note.trim()
            }
            for (const field of ['resolvedAt', 'resolvedBy']) {
              if (typeof event[field] === 'string' && event[field]) {
                stamped[field] = event[field]
              }
            }
            return stamped
          })
        if (events.length > 0) base.sendBacks = events
      }
      // Questions the person being waited on asked WITHOUT finishing. Same
      // stamped shape as a send-back and the same reason for existing: every
      // read re-normalizes, so a key that isn't listed here is erased on the
      // next load. Append-only — asking never resolves anything, so nothing
      // rewrites or removes an entry.
      if (Array.isArray(entry.questions)) {
        const asked = entry.questions
          .filter(
            (event) =>
              event &&
              typeof event.at === 'string' &&
              event.at &&
              typeof event.by === 'string' &&
              event.by,
          )
          .map((event) => {
            const stamped = { at: event.at, by: event.by }
            if (typeof event.note === 'string' && event.note.trim()) {
              stamped.note = event.note.trim()
            }
            return stamped
          })
        if (asked.length > 0) base.questions = asked
      }
      return base
    })
}

/** Statuses I2 may set. Sending and payment come later and are not settable here. */
const EDITABLE_INVOICE_STATUSES = new Set(['draft', 'reviewed', 'void'])

/** Statuses the PAYMENT side may set. A webhook can never edit lines or amounts. */
const PAYMENT_INVOICE_STATUSES = new Set(['sent', 'processing', 'paid', 'overdue'])

/**
 * Statuses an invoice may be in when a retainer credit is ADDED to it.
 *
 * Deliberately the pre-send half of the lifecycle. Applying the credit changes
 * what the client owes, and doing that to an invoice that has already gone out
 * would mean the copy in their inbox and the copy of record disagree about the
 * amount — with no send to tell them so. It does NOT constrain an invoice that
 * already carries a credit: once applied, the decision travels with the invoice
 * through sent, paid and the rest.
 */
const RETAINER_CREDITABLE_STATUSES = new Set(['draft', 'reviewed'])

/**
 * The line kinds an invoice may contain, including the ones only I2 adds.
 *
 * `card-fee` is written by the payment webhook, not by a person: it is the
 * grossed-up processing fee, appended to the stored lines when a client actually
 * pays by card so the invoice of record shows the money that actually arrived.
 * It is in this set because every line goes through `sanitizeInvoiceLines`, and
 * a kind that is not listed here is rewritten to 'custom' — which would make the
 * fee indistinguishable from a hand-typed line and break the guard that stops it
 * being appended twice.
 */
const INVOICE_LINE_KINDS = new Set([
  'plan',
  'hourly',
  'reimbursement',
  'recurring',
  'adjustment',
  'custom',
  'card-fee',
  // One-off work outside the client's scope. Listed here for the same reason
  // 'card-fee' is: falling back to 'custom' would lose the owner's
  // billed/courtesy/omitted choice and the group it belongs to.
  'adhoc',
  // The single line of a retainer invoice, and the negative line that gives that
  // money back on the final invoice. Both are listed for the same reason as the
  // two above: falling back to 'custom' would make the credit an ordinary
  // hand-typed negative line, and the never-applied-twice rule below has nothing
  // left to recognize.
  'retainer',
  'retainer_credit',
  // The optional time breakdown. Listed for the same reason as the rest:
  // falling back to 'custom' would turn a $0.00 informational line into an
  // ordinary hand-typed one, and the round trip through the editor would lose
  // what it is. It carries no amount by construction — see `timeBreakdownLines`.
  'time_detail',
])

/**
 * The retainer-credit rules the store enforces, raised so the API can answer
 * with a sentence rather than a 500.
 *
 * Same shape as `StaleWorkspaceError`: a refusal that is a FACT about the data,
 * not a bug, and the person who hit it needs to be told which fact.
 */
export class RetainerCreditError extends Error {
  constructor(message) {
    super(message)
    this.name = 'RetainerCreditError'
  }
}

/**
 * A manual payment action the invoice's state cannot honor — marking paid what
 * is already settling, un-marking what a real webhook settled. Same shape and
 * same reason as the classes around it: a fact about the data, said in a
 * sentence the owner can act on.
 */
export class ManualPaymentError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ManualPaymentError'
  }
}

/**
 * An edit aimed at an invoice whose content is frozen — see
 * `LOCKED_INVOICE_STATUSES` in lib/invoice-lines.js. Same shape and same reason
 * as the two around it: a fact about the data, said in a sentence she can act on.
 */
export class InvoiceLockedError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InvoiceLockedError'
  }
}

/**
 * A covered-date window the owner has been asked about and not yet answered,
 * standing between an invoice and being marked reviewed. Same shape and same
 * reason as `RetainerCreditError`: a fact about the data, said in a sentence.
 */
export class CoverageConfirmationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CoverageConfirmationError'
  }
}

/**
 * A write a BILLING MASTER refuses, or a bill-to link that does not hold.
 *
 * Same shape and same reason as the three above: a fact about the data, said in
 * a sentence the caller can act on rather than a 500. A master is the payer row
 * for a group of companies — "no data enterered or collected but shows data for
 * the 4 combined" (Brittany, featreq-bcee7e31) — so the app REFUSES the writes
 * that would give it data of its own rather than accepting them and ignoring
 * them later, where the difference would surface as a number nobody can find.
 */
export class BillingMasterError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BillingMasterError'
  }
}

/**
 * An answer aimed at a rating or a question that isn't there — a re-rate landed
 * between the page loading and the owner typing, or the id is simply wrong.
 * Same shape and same reason as the two above: a fact about the data, said in a
 * sentence, so the API can answer 404 rather than 500.
 */
export class InvoiceAiReviewError extends Error {
  constructor(message, statusCode = 404) {
    super(message)
    this.name = 'InvoiceAiReviewError'
    // The route answers `error.statusCode ?? 404`, so the default matches what
    // it would have said anyway. 409 is for the one case that is NOT "gone":
    // the rating was replaced while she was typing, and refreshing fixes it.
    this.statusCode = statusCode
  }
}

/** The three bands the rating may claim. Anything else is not a verdict. */
const AI_CONFIDENCE_BANDS = new Set(['high', 'medium', 'low'])

/**
 * The compact diff `invoice_review_events.changes` carries — only the fields
 * that actually moved, each as `{ before, after }`.
 *
 * Four fields, because those are the four a human edits: the lines, the blurb,
 * the due date and the review status. Everything else on the row is written by
 * the machinery (money is recomputed, Stripe ids arrive from webhooks) and
 * recording it would bury the signal this table exists to collect.
 *
 * Returns null when nothing changed — a save that rewrote an invoice with the
 * same values is not an edit, and an event for it would be noise in the corpus
 * the rating prompt learns from.
 */
function buildInvoiceChangeDiff(current, next) {
  const changes = {}
  if (JSON.stringify(current.lineItems ?? []) !== JSON.stringify(next.lineItems ?? [])) {
    changes.lineItems = { before: current.lineItems ?? [], after: next.lineItems ?? [] }
  }
  if ((current.blurb ?? '') !== (next.blurb ?? '')) {
    changes.blurb = { before: current.blurb ?? '', after: next.blurb ?? '' }
  }
  if ((current.dueDate ?? null) !== (next.dueDate ?? null)) {
    changes.dueDate = { before: current.dueDate ?? null, after: next.dueDate ?? null }
  }
  if (current.status !== next.status) {
    changes.status = { before: current.status, after: next.status }
  }
  return Object.keys(changes).length > 0 ? changes : null
}

/**
 * Name what the human just did, from the status move alone.
 *
 * The status transition wins over the edit, because "she approved it" and "she
 * approved it and fixed a line on the way" are the same act as far as the trust
 * record is concerned — and the `changes` payload still says which lines moved.
 */
function classifyInvoiceReviewEvent(current, next) {
  if (current.status === 'draft' && next.status === 'reviewed') return 'reviewed'
  if (current.status === 'reviewed' && next.status === 'draft') return 'unreviewed'
  if (next.status === 'void' && current.status !== 'void') return 'voided'
  return 'edited'
}

/**
 * One line list against another, said in a sentence rather than shipped whole.
 *
 * This feeds a PROMPT, so size is the constraint: two full line arrays per
 * correction would crowd out the draft being rated. Lines are matched by label,
 * which is how a person reads an invoice — a re-priced line is a change, not a
 * delete plus an add.
 */
function summarizeLineItemChange(before, after) {
  const byLabel = (lines) => {
    const map = new Map()
    for (const line of Array.isArray(lines) ? lines : []) {
      map.set(String(line?.label ?? ''), Number(line?.amount) || 0)
    }
    return map
  }
  const from = byLabel(before)
  const to = byLabel(after)
  const removed = []
  const added = []
  const changed = []
  for (const [label, amount] of from) {
    if (!to.has(label)) removed.push(`${label} ($${amount})`)
    else if (to.get(label) !== amount) changed.push(`${label}: $${amount} → $${to.get(label)}`)
  }
  for (const [label] of to) {
    if (!from.has(label)) added.push(`${label} ($${to.get(label)})`)
  }
  const cap = (list) => list.slice(0, 4)
  return { removed: cap(removed), added: cap(added), changed: cap(changed) }
}

const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100

/**
 * Clean the line list coming off the page before it becomes a client-facing
 * document. Amounts are coerced to numbers and rounded to cents (a NaN would
 * otherwise poison every total downstream), labels are trimmed and capped, and
 * an unrecognized `kind` falls back to 'custom' rather than being persisted
 * verbatim. A line with no label and no amount is dropped — that is an empty
 * row she left behind, not a charge.
 *
 * `invoiceKind` is the kind of the invoice these lines belong to. Only a
 * RETAINER invoice may carry a 'retainer' line: that kind means "this is the
 * money an engagement was opened with", and a monthly invoice claiming one
 * would be a second retainer nobody issued, holding no `applied_to_invoice_id`
 * and creditable by nothing. On a monthly invoice it falls back to 'custom' —
 * the same treatment any other kind that does not belong gets — so the charge
 * survives as an ordinary line rather than the save failing on her.
 */
/**
 * The role tiers an invoice line may claim — the four `recapStaffTier`
 * returns (lib/staff-tiers.js). Anything else is dropped rather than stored,
 * so a typo in a payload cannot invent a heading.
 */
const INVOICE_LINE_ROLE_TIERS = new Set(['CFO', 'Accountant', 'Bookkeeper', 'Other'])

function sanitizeInvoiceLines(raw, { invoiceKind = 'monthly' } = {}) {
  return (Array.isArray(raw) ? raw : [])
    .map((line) => {
      const claimed = INVOICE_LINE_KINDS.has(line?.kind) ? line.kind : 'custom'
      const kind = claimed === 'retainer' && invoiceKind !== 'retainer' ? 'custom' : claimed
      const base = {
        kind,
        label: String(line?.label ?? '').trim().slice(0, 300),
        detail: String(line?.detail ?? '').trim().slice(0, 300),
        amount: roundMoney(line?.amount),
      }
      // WHOSE WORK IS THIS LINE? Absent means the invoice's own client, which is
      // every line of every ordinary invoice. On a billing master's consolidated
      // invoice it names the SUB the line was built from, and it is the only
      // record of that: "see what each paid" is read off this field, never
      // recomputed. This sanitizer is the one chokepoint every line passes
      // through and it drops props it does not name — so without this, one round
      // trip through the editor would silently un-attribute a merged invoice.
      // Set on `base`, so all four branches below carry it.
      if (typeof line?.sourceClientId === 'string' && line.sourceClientId) {
        base.sourceClientId = line.sourceClientId
      }
      // WHICH SECTION THIS ROW PRINTS UNDER on the redesigned invoice
      // (featreq-97ae3214). Presentational only — no money is derived from it,
      // and the hours/rate rule below is untouched by it. It rides here for the
      // same reason sourceClientId does: this sanitizer drops what it does not
      // name, so without this one round trip through the editor would strip a
      // line's role and drop it out of its heading. An unknown value is omitted
      // rather than stored, and a line with none renders ungrouped by design.
      if (INVOICE_LINE_ROLE_TIERS.has(line?.roleTier)) {
        base.roleTier = line.roleTier
      }
      // A retainer credit carries the id of the retainer it came out of. That
      // is what lets a save know WHICH retainer to mark applied, and what lets
      // removing the line free that same one again — matching by client and
      // amount would pick the wrong one the moment a client has two.
      if (kind === 'retainer_credit') {
        const retainerInvoiceId =
          typeof line?.retainerInvoiceId === 'string' && line.retainerInvoiceId
            ? line.retainerInvoiceId
            : null
        return { ...base, retainerInvoiceId }
      }

      // A recurring line with a covered-date window carries the window itself
      // and the expense it belongs to. Dropping these on save would strip an
      // unconfirmed line of the very thing being confirmed — and, worse, of the
      // id that ties it back to the ledger the next cycle advances from. The
      // owner may retype the LABEL freely; the dates are hers to change through
      // the confirm control, which is why they are read here rather than
      // trusted from an arbitrary PATCH body's shape.
      if (kind === 'recurring' && typeof line?.recurringId === 'string' && line.recurringId) {
        const covered = {
          ...base,
          recurringId: line.recurringId,
        }
        if (isIsoDate(line?.coverageStart)) covered.coverageStart = line.coverageStart
        if (isIsoDate(line?.coverageEnd)) covered.coverageEnd = line.coverageEnd
        if (line?.needsCoverageConfirmation) covered.needsCoverageConfirmation = true
        if (line?.coverageReason === 'gap' || line?.coverageReason === 'resumed') {
          covered.coverageReason = line.coverageReason
        }
        return covered
      }

      /**
       * An hourly line that carries its own hours and rate — every one the
       * generator has produced since featreq-cfb1536a — has its AMOUNT
       * RE-DERIVED HERE, from those two, on every save.
       *
       * This is her rule made structural: the hours printed on the line times
       * the rate IS the charge, and the editor's hours field is the one thing
       * she edits (round a line up by hand and "the amount just auto
       * calculates"). A payload whose amount disagrees with its own hours —
       * a stale tab, a hand-built request — loses: the hours are the record.
       *
       * Legacy hourly lines without the fields keep their amount as sent, so
       * an old invoice edited today is not silently repriced.
       */
      if (kind === 'hourly') {
        const hours = Number(line?.hours)
        const rate = Number(line?.rate)
        if (
          Number.isFinite(hours) &&
          hours >= 0 &&
          hours <= 100000 &&
          Number.isFinite(rate) &&
          rate >= 0
        ) {
          const cleanHours = Math.round(hours * 100) / 100
          const cleanRate = Math.round(rate * 100) / 100
          return {
            ...base,
            hours: cleanHours,
            rate: cleanRate,
            amount: roundMoney(cleanHours * cleanRate),
          }
        }
        return base
      }

      if (kind !== 'adhoc') return base

      // The owner's three-way choice, made money. While a line is BILLED its
      // amount is hers to overtype, and `adhocAmount` follows it so flipping to
      // courtesy and back restores the number she typed rather than the rate
      // calculation. While it is courtesy or omitted the line is $0.00 and
      // `adhocAmount` is what it holds in reserve.
      //
      // Zeroing here rather than at render is what keeps the totals honest:
      // `recomputeInvoiceMoney` just adds the amounts up, so a courtesy line
      // costs the client nothing and an omitted one is worth nothing whether or
      // not a given surface remembered to filter it.
      const mode = normalizeAdhocMode(line?.adhocMode)
      const reserved = roundMoney(
        mode === 'billed' ? line?.amount : line?.adhocAmount ?? line?.amount,
      )
      return {
        ...base,
        amount: mode === 'billed' ? reserved : 0,
        adhocMode: mode,
        adhocAmount: reserved,
      }
    })
    // A courtesy or omitted adhoc line is $0.00 BY DECISION, not by being an
    // empty row someone left behind, and it still holds the amount it would
    // charge. Resting its survival on the free-text label alone would mean
    // clearing that box deleted the reserve with no way back short of voiding
    // and regenerating the month — so a reserve keeps the line too.
    .filter(
      (line) =>
        line.label !== '' ||
        line.amount !== 0 ||
        (line.kind === 'adhoc' && line.adhocAmount !== 0),
    )
}

/**
 * Subtotal and total from a line list — the ONE server-side money recompute.
 *
 * Adjustment lines sit outside the subtotal: the subtotal is this month's work,
 * the total is what is owed once last month's true-up is applied. Shared by the
 * PATCH (which recomputes from whatever the page sent) and by the webhook path
 * that appends a card processing fee, so a payment can never leave an invoice
 * whose total disagrees with the lines printed next to it.
 *
 * A retainer credit sits outside it for the same reason an adjustment does, and
 * it is the clearer of the two cases: the work done this month did not become
 * cheaper because money was collected up front, so the subtotal keeps saying
 * what the month was worth and the total says what is left to pay.
 */
const SUBTOTAL_EXCLUDED_KINDS = new Set(['adjustment', 'retainer_credit'])

function recomputeInvoiceMoney(lineItems) {
  return {
    subtotal: roundMoney(
      lineItems
        .filter((line) => !SUBTOTAL_EXCLUDED_KINDS.has(line.kind))
        .reduce((sum, line) => sum + line.amount, 0),
    ),
    total: roundMoney(lineItems.reduce((sum, line) => sum + line.amount, 0)),
  }
}

/**
 * Tag an invoice returned by `applyInvoicePayment` with whether that write
 * actually MOVED its status.
 *
 * The webhook emails the client on a transition — an acknowledgment when a bank
 * payment starts, a receipt when it lands — and "the status is now paid" is not
 * the same fact as "the status just became paid". Stripe replays events, and a
 * replay that changes nothing must email nothing.
 *
 * Non-enumerable on purpose: this is a fact about the WRITE, not a column, and
 * it must never ride along into `JSON.stringify` and out of the API as though
 * it were part of the invoice.
 */
function withStatusChanged(invoice, statusChanged) {
  if (!invoice) return invoice
  Object.defineProperty(invoice, 'statusChanged', {
    value: Boolean(statusChanged),
    enumerable: false,
    configurable: true,
  })
  return invoice
}

/**
 * The column list every invoice read selects. It lives beside `mapInvoiceRow`
 * because the two are one contract: a column missing here is not an error, it
 * is `undefined` on the row, and the mapper turns that into a plausible empty
 * value that reaches the UI as fact.
 *
 * That is not hypothetical. `email_log` was left out of this list, so every
 * Postgres read returned `emailLog: []` — the "Sent to … on …" line never
 * rendered in production, and `recordInvoiceSent` rebuilt the log from that
 * empty array, so each send OVERWROTE the previous one. The file backend
 * returned the log intact, so every test passed. Cardinal rule 1, exactly.
 *
 * A unit test pins the parity (see db/store-staleness.test.mjs).
 */
export const INVOICE_SELECT_COLUMNS = `id, client_id, period, number, kind, status, line_items, subtotal, total,
          due_date, blurb, scope_flags, sent_at, paid_at, payment_method,
          stripe_checkout_session_id, stripe_card_session_id,
          stripe_payment_intent_id, email_log, applied_to_invoice_id,
          original_line_items, created_at, updated_at`

/**
 * One invoices row -> the camelCase shape the app and the API speak. jsonb
 * columns come back parsed; numerics come back as STRINGS from pg, so money is
 * coerced here rather than at every call site.
 *
 * Exported so the column-parity test can watch which columns it reads.
 */
export function mapInvoiceRow(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    period: row.period,
    number: row.number,
    // 'monthly' or 'retainer'. Defaulted rather than passed through raw so a row
    // written before the column existed reads as what it actually is.
    kind: row.kind ?? 'monthly',
    status: row.status,
    lineItems: Array.isArray(row.line_items) ? row.line_items : [],
    subtotal: Number(row.subtotal) || 0,
    total: Number(row.total) || 0,
    dueDate: row.due_date ?? null,
    blurb: row.blurb ?? '',
    scopeFlags: Array.isArray(row.scope_flags) ? row.scope_flags : [],
    sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null,
    paidAt: row.paid_at ? new Date(row.paid_at).toISOString() : null,
    paymentMethod: row.payment_method ?? null,
    stripeCheckoutSessionId: row.stripe_checkout_session_id ?? null,
    // The CARD channel's sibling session, for a card-enabled client. Separate
    // from the ACH column rather than replacing it: both are live at once, and
    // whichever one is paid has to be able to expire the other.
    stripeCardSessionId: row.stripe_card_session_id ?? null,
    stripePaymentIntentId: row.stripe_payment_intent_id ?? null,
    emailLog: Array.isArray(row.email_log) ? row.email_log : [],
    // RETAINER invoices only: the invoice this retainer's credit was applied to.
    // Non-null is what makes "already applied" a fact on the row rather than a
    // scan of every other invoice's lines — see `updateInvoice`.
    appliedToInvoiceId: row.applied_to_invoice_id ?? null,
    // The lines as GENERATED, frozen at insert and never written again — the
    // before-side of every correction diff. Null (not `[]`) on a row created
    // before the column existed: an empty array here would read as "she deleted
    // every line", which is the opposite of "we never knew".
    originalLineItems: Array.isArray(row.original_line_items) ? row.original_line_items : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  }
}

/**
 * One `invoice_review_events` row -> the camelCase shape the app speaks.
 * Exported for the same reason `mapInvoiceRow` is: so a test can watch which
 * columns it reads.
 */
export function mapInvoiceReviewEventRow(row) {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    clientId: row.client_id ?? null,
    period: row.period ?? null,
    actorUserId: row.actor_user_id ?? null,
    event: row.event ?? 'edited',
    changes: row.changes && typeof row.changes === 'object' ? row.changes : {},
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  }
}

/** One `invoice_ai_reviews` row -> the shape the month run and the prompt read. */
export function mapInvoiceAiReviewRow(row) {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    clientId: row.client_id ?? null,
    period: row.period ?? null,
    model: row.model ?? null,
    confidence: row.confidence ?? 'medium',
    // pg hands back `integer` as a number, but the file backend's value came
    // from a model — coerce either into the same thing.
    score: Number(row.score) || 0,
    summary: row.summary ?? '',
    concerns: Array.isArray(row.concerns) ? row.concerns : [],
    questions: Array.isArray(row.questions) ? row.questions : [],
    linesFingerprint: row.lines_fingerprint ?? null,
    superseded: Boolean(row.superseded),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  }
}

/**
 * A `date` column -> yyyy-mm-dd, whether pg handed back a Date or a string.
 *
 * Built from the LOCAL components, not `toISOString()`. node-pg materializes a
 * `date` as a JS Date at LOCAL midnight, so converting to UTC first shifts the
 * day backwards on any host east of Greenwich — 2026-08-13 comes back as
 * 2026-08-12. Railway runs UTC, which is exactly what makes this the kind of
 * bug that never shows up until it does. It matters more here than it used to:
 * `coverage_end` is what seeds the cycle's anchor day, so a one-day slip would
 * move a client's billing date.
 */
const columnDateOnly = (value) => {
  if (!value) return null
  if (value instanceof Date) {
    const pad2 = (n) => String(n).padStart(2, '0')
    return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`
  }
  return String(value).slice(0, 10)
}

/**
 * One recurring_reimbursements row -> the camelCase shape the app speaks.
 *
 * Exists because the coverage columns made this a seven-field job done in three
 * places (the workspace read, create, update) — and Cardinal rule 1 says a
 * Postgres-only omission passes CI in silence, so the three read one function.
 *
 * Exported for the column-parity test.
 */
export function mapRecurringReimbursementRow(row) {
  // Column names become field names here; the SHARED normalizer then decides
  // what every absent or malformed coverage field means, so this backend and
  // the file backend cannot disagree about a row that predates the feature.
  return normalizeRecurringReimbursement({
    id: row.id,
    clientId: row.client_id,
    description: row.description,
    amount: Number(row.amount),
    frequency: row.frequency,
    startDate: columnDateOnly(row.start_date),
    coverageEnabled: row.coverage_enabled,
    coverageTemplate: row.coverage_template,
    coverageStart: columnDateOnly(row.coverage_start),
    coverageEnd: columnDateOnly(row.coverage_end),
    coverageAnchorDay: row.coverage_anchor_day,
    coveragePaused: row.coverage_paused,
    coverageResumePending: row.coverage_resume_pending,
    coverageHistory: row.coverage_history,
  })
}

/**
 * The coverage half of a recurring reimbursement, validated.
 *
 * Everything the page can send about covered dates passes through here, on
 * BOTH the create and the update path, so a hand-rolled PATCH cannot seed a
 * window with a nonsense date or an end that precedes its start.
 *
 * Returns `{ ok: false }` when something is wrong — the caller answers null,
 * matching how the rest of this record's validation already behaves.
 */
function sanitizeCoverageInput(patch, { partial = false } = {}) {
  const out = {}
  if (patch.coverageEnabled !== undefined) out.coverageEnabled = Boolean(patch.coverageEnabled)
  if (patch.coveragePaused !== undefined) out.coveragePaused = Boolean(patch.coveragePaused)
  if (patch.coverageTemplate !== undefined) {
    out.coverageTemplate = String(patch.coverageTemplate ?? '').trim().slice(0, 500)
  }
  for (const key of ['coverageStart', 'coverageEnd']) {
    if (patch[key] === undefined) continue
    const value = patch[key]
    // Empty clears the window — that is how she turns the feature back off
    // without deleting the expense.
    if (value === null || value === '') {
      out[key] = null
      continue
    }
    if (!isIsoDate(value)) return { ok: false }
    out[key] = value
  }
  // Only checkable when both ends are in hand. On a partial update the caller
  // re-checks against the merged record, which is where the pair really lives.
  if (!partial && out.coverageStart && out.coverageEnd && out.coverageEnd <= out.coverageStart) {
    return { ok: false }
  }
  return { ok: true, values: out }
}

function normalizeSubSubItems(raw, { withDone = true } = {}) {
  const list = Array.isArray(raw) ? raw : []
  return list
    .filter((sub) => sub && typeof sub.title === 'string' && sub.title.trim())
    .map((sub) => {
      const base = {
        id:
          typeof sub.id === 'string' && sub.id
            ? sub.id
            : `subsubitem-${randomUUID().slice(0, 8)}`,
        title: sub.title.trim(),
      }
      if (withDone) base.done = Boolean(sub.done)
      // Preserve the per-node due spec — template nodes carry the recurring
      // `dueDayOfMonth` / fixed `dueDate`; live nodes carry only a concrete
      // resolved `dueDate`. Dropping these silently loses sub-node due dates.
      if (typeof sub.dueDate === 'string' && sub.dueDate) base.dueDate = sub.dueDate
      if (typeof sub.dueDayOfMonth === 'number' && sub.dueDayOfMonth >= 1) {
        base.dueDayOfMonth = sub.dueDayOfMonth
      }
      // Preserve structured person-blockers on live sub-sub nodes.
      if (withDone) {
        const waitingOns = normalizeWaitingOns(sub.waitingOns)
        if (waitingOns.length > 0) base.waitingOns = waitingOns
      }
      return base
    })
}

/**
 * Normalize a raw sub-items value (JSONB column or app-shaped array) into a
 * clean `{ id, title, done, subItems? }[]`. Drops malformed entries. Recurses
 * one level deeper to normalize any sub-sub-items. `withDone` controls whether
 * `done` is included (live checklists carry it; template items don't). For a
 * sub-item that has sub-sub-items `done` is derived from those.
 */
function normalizeSubItems(raw, { withDone = true } = {}) {
  const list = Array.isArray(raw) ? raw : []
  return list
    .filter((sub) => sub && typeof sub.title === 'string' && sub.title.trim())
    .map((sub) => {
      const base = {
        id: typeof sub.id === 'string' && sub.id ? sub.id : `subitem-${randomUUID().slice(0, 8)}`,
        title: sub.title.trim(),
      }
      // Preserve the per-node due spec (see normalizeSubSubItems) so sub-item
      // due dates survive the JSONB round-trip.
      if (typeof sub.dueDate === 'string' && sub.dueDate) base.dueDate = sub.dueDate
      if (typeof sub.dueDayOfMonth === 'number' && sub.dueDayOfMonth >= 1) {
        base.dueDayOfMonth = sub.dueDayOfMonth
      }
      // Preserve the "waiting on" flag + note on live sub-items so they survive
      // the JSONB round-trip (drives the owner's Delayed page).
      if (withDone) {
        if (sub.waiting) base.waiting = true
        if (typeof sub.waitingOn === 'string' && sub.waitingOn.trim()) {
          base.waitingOn = sub.waitingOn.trim()
        }
        if (typeof sub.waitingForChecklistId === 'string' && sub.waitingForChecklistId) {
          base.waitingForChecklistId = sub.waitingForChecklistId
        }
        // Preserve structured person-blockers on live sub-items.
        const waitingOns = normalizeWaitingOns(sub.waitingOns)
        if (waitingOns.length > 0) base.waitingOns = waitingOns
      }
      const subSubItems = normalizeSubSubItems(sub.subItems, { withDone })
      if (subSubItems.length > 0) {
        base.subItems = subSubItems
      }
      if (withDone) {
        // A sub-item with sub-sub-items is the roll-up of those; otherwise it
        // keeps its own stored `done`.
        base.done =
          subSubItems.length > 0
            ? subSubItems.every((subSub) => Boolean(subSub.done))
            : Boolean(sub.done)
      }
      return base
    })
}

/**
 * Roll-up completion for a checklist node, recursing up to three levels
 * (item → sub-item → sub-sub-item): a node with children is `done` exactly
 * when every child is `done`; a node with no children keeps its own `done`.
 * Mirrors `isChecklistItemDone` in src/lib/utils.ts.
 */
function rollUpItemDone(item) {
  if (Array.isArray(item.subItems) && item.subItems.length > 0) {
    return item.subItems.every((sub) => rollUpItemDone(sub))
  }
  return Boolean(item.done)
}

/**
 * Columns `mapChecklistItemRow` reads. Same contract as
 * `INVOICE_SELECT_COLUMNS`: a column added to the mapper but not to this list
 * reads as `undefined` on Postgres and as the real value on the file backend,
 * so the bug is invisible to every test in this repo and visible only in
 * production. `checklist_id` is here for the caller's grouping, not the mapper.
 *
 * A unit test pins the parity (see db/store-staleness.test.mjs).
 */
export const CHECKLIST_ITEM_SELECT_COLUMNS = `id, checklist_id, label, done, sort_order, due_date,
          due_day_of_month, assignee_id, waiting_on, waiting, waiting_for_checklist_id,
          waiting_ons, sub_items, completed_at`

/**
 * One `checklist_items` row -> the shape the app speaks. Optional fields are
 * omitted rather than set to null so a flat item stays flat (the file backend
 * stores exactly what the UI sends, and the two shapes have to match).
 *
 * Exported so the column-parity test can watch which columns it reads.
 */
export function mapChecklistItemRow(row) {
  const subItems = normalizeSubItems(row.sub_items, { withDone: true })
  const item = {
    id: row.id,
    label: row.label,
    done: row.done,
  }
  if (row.due_date) {
    item.dueDate = row.due_date.toISOString().slice(0, 10)
  }
  if (typeof row.due_day_of_month === 'number') {
    item.dueDayOfMonth = row.due_day_of_month
  }
  if (row.assignee_id) {
    item.assigneeId = row.assignee_id
  }
  if (row.waiting_on) {
    item.waitingOn = row.waiting_on
  }
  // An item flagged waiting OR carrying a legacy "waiting on" note (from
  // before the toggle existed) is treated as waiting.
  if (row.waiting || row.waiting_on) {
    item.waiting = true
  }
  if (row.waiting_for_checklist_id) {
    item.waitingForChecklistId = row.waiting_for_checklist_id
  }
  const itemWaitingOns = normalizeWaitingOns(row.waiting_ons)
  if (itemWaitingOns.length > 0) {
    item.waitingOns = itemWaitingOns
  }
  if (subItems.length > 0) {
    item.subItems = subItems
    // `done` is derived for items with sub-items (which may themselves be
    // derived from sub-sub-items) — keep it in sync on read so a hand-edited
    // DB row can't desync the roll-up.
    item.done = rollUpItemDone(item)
  }
  // Only emitted when there is one. An item completed before the column
  // existed has no timestamp and must not be given a fabricated one.
  if (row.completed_at) {
    item.completedAt = new Date(row.completed_at).toISOString()
  }
  return item
}

/**
 * SQL fragment that keeps `completed_at` truthful whenever `done` is written.
 *
 * `$${n}` is the parameter carrying the NEW `done` value:
 *   - completing -> stamp now(), unless the row already carries a stamp
 *     (re-asserting `done` on an already-complete step is not a re-completion)
 *   - un-completing -> clear it; a reopened step has no completion date
 *
 * Written as one expression inside the same UPDATE as `done` so the two can
 * never drift, and so no code path can set `done` without deciding this.
 */
function completedAtClause(doneParamIndex) {
  return `completed_at = case when $${doneParamIndex} then coalesce(completed_at, now()) else null end`
}

/**
 * Every table the bulk save wipes that HAS a `created_at` column and is
 * re-inserted from the payload — i.e. every table whose creation dates the wipe
 * would otherwise reset to `now()`.
 *
 * The full list of tables `write()` deletes is fourteen. The four missing here:
 *   - `invoices`            — already snapshotted and restored verbatim.
 *   - `time_entries`        — already supplies `created_at` on its insert.
 *   - `timesheet_locks`     — no `created_at`; `locked_at` is supplied.
 *   - `weekly_submissions`  — no `created_at`; `submitted_at` is supplied.
 * `checklist_template_stages` has no `created_at` column at all, so it has
 * nothing to lose. `users` is upserted, never deleted, and its ON CONFLICT
 * touches name + updated_at only.
 *
 * Exported so a test can assert the insert for each one names the column.
 */
export const CREATED_AT_PRESERVED_TABLES = [
  'subscription_plans',
  'contacts',
  'clients',
  'reimbursements',
  'recurring_reimbursements',
  'checklist_templates',
  'checklist_template_items',
  'checklists',
  'checklist_items',
]

/**
 * The completion stamp a BULK SAVE should persist for a checklist item.
 *
 * The payload's own `completedAt` is deliberately ignored. The bulk save
 * re-inserts every row from whatever snapshot the calling tab holds, so trusting
 * it would let a stale tab rewrite completion history — the same class of bug as
 * the `created_at` reset this function's callers exist to fix.
 *
 * @param {boolean} done the roll-up `done` being persisted now
 * @param {{ done?: boolean, completedAt?: Date|string|null }} [previous] the row
 *   as it stood BEFORE the wipe, or undefined for a genuinely new item
 * @returns {Date|string|null} what to write to `completed_at`
 */
export function preservedItemCompletion(done, previous) {
  if (!done) return null
  // Already carried a stamp — keep the real one.
  if (previous?.completedAt) return previous.completedAt
  // Already complete but never stamped: a row from before the column existed.
  // Leave it null rather than backdating it to this save.
  if (previous?.done) return null
  // This save is what completed it (or the item is new and arrives complete).
  return new Date()
}

/**
 * Return `node` with its waiting-on state taken from what is ALREADY STORED
 * rather than from the bulk-save payload, recursing through sub-items and
 * sub-sub-items. Both backends call it (Cardinal rule 1).
 *
 * WHY THE PAYLOAD CANNOT BE TRUSTED WITH THIS. `waitingOns` is written only by
 * the dedicated waiting-on routes — nothing in the UI edits it — so a bulk save
 * carrying a different value is always a stale snapshot, never an intention.
 * The staleness guard normally catches that, and for the ordinary tab it does;
 * this is the belt to its braces, and there is at least one live scenario where
 * the braces alone are thin: a scoped GET hands back the FULL-workspace
 * fingerprint, so a tab that only ever saw part of the workspace can still
 * present a "current" token. Preserving on write makes the permanence her rule
 * asks for STRUCTURAL — a wait cannot be erased by a save that never meant to
 * touch it, whatever the fingerprint said.
 *
 * The trio (`waiting`, `waitingOn`, `waitingForChecklistId`) is preserved only
 * while a LIVE saved wait sits on the node — exactly the fields, and exactly the
 * window, that `waitingLockRefusal` freezes on the PATCH routes. With no live
 * wait they are ordinary editable step fields and the payload wins, because the
 * free-text note and the amber flag genuinely are a tab's to change.
 *
 * These fields are deliberately NOT in `VERSION_IGNORED_*`: unlike the coverage
 * ledger, a wait mutation SHOULD move the fingerprint — every open tab needs to
 * refetch a wait that changed, and ordinary tab payloads carry the same values
 * back, so nothing here produces the false 409s that exclusion exists to avoid.
 *
 * @param {object} node - the payload's node.
 * @param {object|undefined} stored - the same node as persisted, or undefined
 *   when it is genuinely new (then the payload is all there is, which is right).
 */
export function preservedNodeWaits(node, stored) {
  if (!node || typeof node !== 'object') return node
  const next = { ...node }
  if (stored) {
    const storedWaits = normalizeWaitingOns(stored.waitingOns)
    if (storedWaits.length > 0) next.waitingOns = storedWaits
    else delete next.waitingOns
    if (storedWaits.some(isWaitingOnOpen)) {
      if (stored.waiting) next.waiting = true
      else delete next.waiting
      if (typeof stored.waitingOn === 'string' && stored.waitingOn) {
        next.waitingOn = stored.waitingOn
      } else delete next.waitingOn
      if (typeof stored.waitingForChecklistId === 'string' && stored.waitingForChecklistId) {
        next.waitingForChecklistId = stored.waitingForChecklistId
      } else delete next.waitingForChecklistId
    }
  }
  if (Array.isArray(node.subItems)) {
    const storedSubById = new Map(
      (Array.isArray(stored?.subItems) ? stored.subItems : [])
        .filter((sub) => sub && typeof sub.id === 'string')
        .map((sub) => [sub.id, sub]),
    )
    next.subItems = node.subItems.map((sub) =>
      sub && typeof sub.id === 'string'
        ? preservedNodeWaits(sub, storedSubById.get(sub.id))
        : sub,
    )
  }
  return next
}

/**
 * File-backend mirror of `completedAtClause`: return `item` with its new `done`
 * and a `completedAt` that follows the same rule. The prior item IS the "before"
 * state here, so an already-stamped completion is kept and a reopened step loses
 * its date.
 */
function withCompletionStamp(item, done) {
  const next = { ...item, done }
  const completedAt = preservedItemCompletion(done, item)
  if (completedAt) {
    next.completedAt = completedAt instanceof Date ? completedAt.toISOString() : completedAt
  } else {
    delete next.completedAt
  }
  return next
}

/**
 * Set every sub-sub-item under a sub-item to `value`. Returns a new sub-item.
 */
function cascadeSubItem(sub, value) {
  const subSubItems = normalizeSubSubItems(sub.subItems, { withDone: true })
  const next = { ...sub, done: value }
  if (subSubItems.length > 0) {
    next.subItems = subSubItems.map((subSub) => ({ ...subSub, done: value }))
  }
  return next
}

/**
 * Pure toggle of a checklist item's `done`/`subItems`, recursing the three
 * levels. Given the item's current `subItems` and `done`, plus which depth is
 * being toggled, returns the next `{ subItems, done }` — or `null` when the
 * referenced sub-item / sub-sub-item does not exist.
 *
 * - `subSubItemId`: flip that sub-sub-item; recompute its sub-item, then the
 *   top item.
 * - `subItemId` only: flip that sub-item, cascading down to all its
 *   sub-sub-items; recompute the top item.
 * - neither: flip the top item, cascading all the way down.
 */
function applyItemToggle(rawSubItems, itemDone, { subItemId, subSubItemId } = {}) {
  const subItems = normalizeSubItems(rawSubItems, { withDone: true })

  if (subSubItemId) {
    if (!subItemId) return null
    const parent = subItems.find((sub) => sub.id === subItemId)
    if (!parent) return null
    const parentSubSubItems = normalizeSubSubItems(parent.subItems, { withDone: true })
    if (!parentSubSubItems.some((subSub) => subSub.id === subSubItemId)) return null
    const nextSubItems = subItems.map((sub) => {
      if (sub.id !== subItemId) return sub
      const nextSubSubItems = parentSubSubItems.map((subSub) =>
        subSub.id === subSubItemId ? { ...subSub, done: !subSub.done } : subSub,
      )
      return {
        ...sub,
        subItems: nextSubSubItems,
        done: nextSubSubItems.every((subSub) => subSub.done),
      }
    })
    return { subItems: nextSubItems, done: nextSubItems.every((sub) => sub.done) }
  }

  if (subItemId) {
    const target = subItems.find((sub) => sub.id === subItemId)
    if (!target) return null
    // Toggling a sub-item flips it and cascades to every sub-sub-item.
    const cascadeValue = !rollUpItemDone(target)
    const nextSubItems = subItems.map((sub) =>
      sub.id === subItemId ? cascadeSubItem(sub, cascadeValue) : sub,
    )
    return { subItems: nextSubItems, done: nextSubItems.every((sub) => sub.done) }
  }

  if (subItems.length > 0) {
    // Toggling the top item cascades to every sub-item and sub-sub-item.
    const cascadeValue = !subItems.every((sub) => rollUpItemDone(sub))
    const nextSubItems = subItems.map((sub) => cascadeSubItem(sub, cascadeValue))
    return { subItems: nextSubItems, done: cascadeValue }
  }

  return { subItems, done: !itemDone }
}

function buildChecklistFromStage({
  template,
  stage,
  stageIndex,
  stageCount,
  caseId,
  dueDate,
  completed = false,
}) {
  // When `completed` is true (a specific-months instance for a month whose
  // due date is already in the past), every item/sub-item/sub-sub-item is
  // born `done:true` so the historical occurrence shows as finished.
  // Derive the cycle month from the stage's resolved due date so each node's
  // recurring day-of-month lands in the right month.
  const [cycleYear, cycleMonth] = dueDate.split('-').map(Number)
  return {
    id: `check-${randomUUID().slice(0, 8)}`,
    templateId: template.id,
    title: template.title,
    clientId: template.clientId,
    assigneeId: stage.assigneeId,
    frequency: template.frequency,
    dueDate,
    viewerIds: Array.isArray(stage.viewerIds) ? [...stage.viewerIds] : [],
    editorIds: Array.isArray(stage.editorIds) ? [...stage.editorIds] : [],
    caseId,
    stageId: stage.id,
    stageIndex,
    stageCount,
    // Inherit the template's board column so generated instances sort correctly.
    categoryId: template.categoryId ?? null,
    // "and then the next would spring forward" — derived from THIS instance's
    // due date, so next cycle's instance names the next period without any
    // counter to keep in step. Null when the template does not carry one.
    periodLabel: periodLabelForInstance(template, dueDate),
    // Onboarding link: every stage checklist of an onboarding case inherits the
    // template's `onboardingForClientId`, so completing/advancing any stage can
    // sync the client's lifecycle stage. Absent on ordinary templates.
    ...(template.onboardingForClientId
      ? { onboardingForClientId: template.onboardingForClientId }
      : {}),
    items: stage.items.map((item) => {
      const itemDue = resolveNodeDueDate(item, cycleYear, cycleMonth)
      return {
        id: `item-${randomUUID().slice(0, 8)}`,
        label: item.label,
        done: completed,
        ...(itemDue ? { dueDate: itemDue } : {}),
        ...(item.assigneeId ? { assigneeId: item.assigneeId } : {}),
        ...(Array.isArray(item.subItems) && item.subItems.length > 0
          ? {
              subItems: item.subItems.map((sub) => {
                const subDue = resolveNodeDueDate(sub, cycleYear, cycleMonth)
                return {
                  id: `subitem-${randomUUID().slice(0, 8)}`,
                  title: sub.title,
                  done: completed,
                  ...(subDue ? { dueDate: subDue } : {}),
                  ...(Array.isArray(sub.subItems) && sub.subItems.length > 0
                    ? {
                        subItems: sub.subItems.map((subSub) => {
                          const subSubDue = resolveNodeDueDate(subSub, cycleYear, cycleMonth)
                          return {
                            id: `subsubitem-${randomUUID().slice(0, 8)}`,
                            title: subSub.title,
                            done: completed,
                            ...(subSubDue ? { dueDate: subSubDue } : {}),
                          }
                        }),
                      }
                    : {}),
                }
              }),
            }
          : {}),
      }
    }),
  }
}

/**
 * Backfill `assignedBookkeeperIds` on each client from existing live
 * checklists, recurring templates, and template stages. Idempotent. Owners
 * are never added — visibility scoping is for non-owner roles only. Returns
 * the (possibly mutated) clients array and a `changed` flag.
 */
function backfillAssignedBookkeepers(data) {
  const clients = Array.isArray(data.clients) ? data.clients : []
  if (clients.length === 0) {
    return { changed: false, clients }
  }
  const employees = Array.isArray(data.employees) ? data.employees : []
  const ownerIds = new Set(employees.filter((e) => e.role === 'Owner').map((e) => e.id))
  const known = new Set(employees.map((e) => e.id))

  const byClient = new Map(
    clients.map((client) => [
      client.id,
      new Set(
        Array.isArray(client.assignedBookkeeperIds)
          ? client.assignedBookkeeperIds.filter((id) => typeof id === 'string')
          : [],
      ),
    ]),
  )

  const grant = (clientId, userId) => {
    if (!clientId || !userId || ownerIds.has(userId) || !known.has(userId)) return
    const set = byClient.get(clientId)
    if (set) set.add(userId)
  }

  for (const checklist of data.checklists ?? []) {
    grant(checklist.clientId, checklist.assigneeId)
  }
  for (const template of data.checklistTemplates ?? []) {
    grant(template.clientId, template.assigneeId)
    for (const stage of template.stages ?? []) {
      grant(template.clientId, stage.assigneeId)
    }
  }

  let changed = false
  const nextClients = clients.map((client) => {
    const set = byClient.get(client.id) ?? new Set()
    const next = [...set]
    const prev = Array.isArray(client.assignedBookkeeperIds) ? client.assignedBookkeeperIds : []
    if (prev.length !== next.length || prev.some((id) => !set.has(id))) {
      changed = true
    }
    return { ...client, assignedBookkeeperIds: next }
  })

  return { changed, clients: nextClients }
}

/**
 * SECURITY (M4): decide whether a self-service password change is allowed.
 * Pure function so the branching can be unit-tested without a DB or any
 * crypto. The caller supplies the facts; this returns the verdict and, on
 * rejection, the HTTP status + message the endpoint should send.
 *
 * Rules:
 *  - `passwordSetAt` null/falsy  -> the user has never set their OWN password
 *    (still on the seed/random default). A valid session is enough to set a
 *    first password — they can't know the random default, and a magic-link
 *    sign-in already proves inbox control. `currentPassword` is ignored.
 *  - `passwordSetAt` set         -> a current-password challenge is required.
 *    `currentPasswordProvided` must be true AND `currentPasswordValid` must be
 *    true; otherwise reject so a hijacked session can't silently rotate the
 *    password and lock the real user out.
 *
 * @param {object} args
 * @param {*} args.passwordSetAt          Truthy when the user has set their own password.
 * @param {boolean} args.currentPasswordProvided  A non-empty currentPassword was sent.
 * @param {boolean} args.currentPasswordValid     The supplied currentPassword verified.
 * @returns {{ allowed: boolean, status?: number, error?: string }}
 */
export function evaluatePasswordChange({
  passwordSetAt,
  currentPasswordProvided,
  currentPasswordValid,
}) {
  // First-time set: session alone is sufficient.
  if (!passwordSetAt) {
    return { allowed: true }
  }
  // A password already exists — require the current one.
  if (!currentPasswordProvided) {
    return {
      allowed: false,
      status: 400,
      error: 'Current password is required to change your password.',
    }
  }
  if (!currentPasswordValid) {
    return {
      allowed: false,
      status: 403,
      error: 'Current password is incorrect.',
    }
  }
  return { allowed: true }
}

// Largest value we'll ever persist for a money/hours field. Anything beyond
// this is certainly garbage (overflow, malformed paste, hostile payload) so
// we clamp rather than store a number that would blow up downstream math or
// the numeric/JSON columns. One billion is comfortably past any real rate.
const MAX_SANE_NUMBER = 1e9
// A single time entry should never exceed this many minutes (~69 days). Real
// entries are minutes-to-hours; this just stops an absurd value from skewing
// totals or overflowing the integer column.
const MAX_ENTRY_MINUTES = 100000

/**
 * Coerce a value to a finite number clamped into [0, MAX_SANE_NUMBER].
 * Non-finite (NaN, Infinity, non-numeric strings) and negatives collapse to 0.
 * Used for money/hours fields where "garbage in" must never reject the save —
 * we normalize in place instead. Returns the cleaned number.
 */
function clampMoney(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  if (n > MAX_SANE_NUMBER) return MAX_SANE_NUMBER
  return n
}

/**
 * The single rule for coercing a time entry's `minutes` on any write path.
 *
 * Minutes are NOT whole numbers. An entry built from its `sessions` spans
 * carries a seconds-exact fraction (14.533… = 14m 32s) and the Postgres column
 * is `numeric` precisely so that survives — so we snap to the nearest whole
 * SECOND and never to the nearest minute. Rounding to an integer here silently
 * rewrote the real duration of every entry on each owner-tab bulk save.
 *
 * Guards (unchanged): non-finite or <= 0 collapses to the 1-minute floor —
 * never drop a logged entry — and absurd values clamp to MAX_ENTRY_MINUTES.
 */
export function coerceEntryMinutes(value) {
  const minutes = Math.round(Number(value) * 60) / 60
  if (!Number.isFinite(minutes) || minutes <= 0) return 1
  if (minutes > MAX_ENTRY_MINUTES) return MAX_ENTRY_MINUTES
  return minutes
}

/**
 * The `group_allocation` column only ever holds one of the three split modes.
 * Anything else (including absent) persists as NULL.
 */
export function normalizeGroupAllocation(value) {
  return value === 'even' || value === 'full' || value === 'custom' ? value : null
}

/**
 * Why a `splitTimeEntry` call could not proceed. `code` is one of:
 *   - `not_found`  — no such entry (someone deleted it first).
 *   - `not_holding` — the entry has neither a client nor group members, which
 *     in practice means a concurrent request already split it.
 *   - `not_splittable` — administrative time: there is no client to divide.
 *   - `single_allocation` — a regular client entry was handed ONE allocation.
 *     Moving time to a different client is the edit form's client dropdown, not
 *     a split; refusing here keeps a "split" from silently becoming a re-bill.
 * All are clean conflicts, never a half-written split: the Postgres branch
 * holds `select … for update` on the target row, and the file branch validates
 * before it writes anything.
 */
export class TimeEntrySplitError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TimeEntrySplitError'
    this.code = code
  }
}

/**
 * True only for a plain `YYYY-MM-DD` string whose year is in the sane window
 * (2000–2100) AND which round-trips as a real calendar date (so 2026-02-31 is
 * rejected). Conservative on purpose: a valid date returns true and is left
 * untouched by the sanitizer; anything else returns false so the caller can
 * drop just that field rather than persisting garbage.
 */
function isSaneDateString(value) {
  if (typeof value !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return false
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  if (year < 2000 || year > 2100) return false
  if (month < 1 || month > 12) return false
  if (day < 1 || day > 31) return false
  // Reject impossible calendar dates (e.g. Feb 31) by round-tripping.
  const dt = new Date(Date.UTC(year, month - 1, day))
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  )
}

/**
 * Drop a date-valued field IN PLACE when it's present but clearly invalid.
 * A missing/empty field is left as-is (nothing to clean). A valid date is
 * left EXACTLY as-is. Only a present-but-garbage value gets removed, so the
 * persisted record never carries an unparseable date that would crash a
 * later read/render. `key` is the property name on `record`.
 */
function dropInvalidDateField(record, key) {
  const value = record[key]
  // Nothing there (or intentionally blank) — leave it alone.
  if (value === undefined || value === null || value === '') return
  if (!isSaneDateString(value)) {
    delete record[key]
  }
}

/**
 * Coerce a contact's `company_emails` (a jsonb column, or the in-memory
 * `companyEmails` array on a save payload) to a clean array of
 * `{ clientId, email }` objects. node-pg usually hands back parsed jsonb, but a
 * raw string is tolerated. Malformed entries are dropped.
 */
function parseCompanyEmails(value) {
  let raw = value
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof entry.clientId === 'string' &&
        typeof entry.email === 'string',
    )
    .map((entry) => ({ clientId: entry.clientId, email: entry.email }))
}

/**
 * Defensive, NON-REJECTING normalizer run at the very top of
 * `appDataStore.write()` before either persistence branch. The overriding
 * rule: a normal save's values pass through UNCHANGED — we only clamp/normalize
 * clearly-bad data and we NEVER throw or reject the whole blob (the owner may
 * be doing month-end billing right now). Mutates `data` in place and returns it.
 *
 * What it cleans:
 *  - Missing top-level arrays are coerced to [].
 *  - Records that aren't objects, or lack a string `id`, are dropped from
 *    their array so one bad record can't crash the whole save.
 *  - Money/hours fields (client rates/hours, reimbursement amounts) are
 *    coerced finite and clamped to [0, 1e9].
 *  - timeEntries[].minutes is coerced to a positive number in (0, 100000],
 *    keeping sub-minute precision (rounded to the nearest whole SECOND).
 *  - Date fields that are present but not a sane YYYY-MM-DD are dropped.
 */
export function sanitizeAppData(data) {
  if (!data || typeof data !== 'object') return data

  // Arrays the rest of write() iterates with `for...of` (no Array.isArray
  // guard) — coerce a missing/garbage value to [] so the loop can't throw.
  const ARRAY_KEYS = [
    'employees',
    'clients',
    'plans',
    'contacts',
    'timeEntries',
    'reimbursements',
    'recurringReimbursements',
    'checklists',
    'recycledChecklists',
    'checklistTemplates',
  ]
  for (const key of ARRAY_KEYS) {
    if (!Array.isArray(data[key])) {
      data[key] = []
    }
  }

  // Keep only well-formed records (object with a string id). A single
  // malformed record must never wedge the entire bulk save.
  const keepValidRecords = (key) => {
    data[key] = data[key].filter(
      (record) =>
        record && typeof record === 'object' && typeof record.id === 'string',
    )
  }
  for (const key of ARRAY_KEYS) {
    keepValidRecords(key)
  }

  // De-duplicate each array by `id`. Every reinsert loop in write() except
  // `users` is a bare INSERT (no ON CONFLICT), so two records sharing an id in
  // the payload would raise a duplicate-key error and abort the WHOLE
  // transaction — 500-ing every read via the materialize-on-read path. Keep the
  // last occurrence (latest client state wins).
  const dedupeById = (key) => {
    const byId = new Map()
    for (const record of data[key]) byId.set(record.id, record)
    data[key] = [...byId.values()]
  }
  for (const key of ARRAY_KEYS) {
    dedupeById(key)
  }

  for (const client of data.clients) {
    // The file backend has no column to clamp against, so the bulk save is the
    // only place a bad stage can be caught before it reaches every picker in
    // the app. Guarded on presence so a client that never had the field keeps
    // not having it (absent already reads as 'active' everywhere).
    if ('lifecycleStage' in client) {
      client.lifecycleStage = coerceLifecycleStage(client.lifecycleStage)
    }
    if ('hourlyRate' in client) client.hourlyRate = clampMoney(client.hourlyRate)
    if ('monthlyRate' in client) client.monthlyRate = clampMoney(client.monthlyRate)
    if ('annualRate' in client) client.annualRate = clampMoney(client.annualRate)
    if ('annualBillingMonth' in client) {
      const month = Number(client.annualBillingMonth)
      client.annualBillingMonth =
        Number.isFinite(month) && month >= 1 && month <= 12 ? Math.floor(month) : undefined
    }
    if ('estimatedMonthlyHours' in client) {
      client.estimatedMonthlyHours = clampMoney(client.estimatedMonthlyHours)
    }
    if ('estimatedBookkeeperHours' in client) {
      client.estimatedBookkeeperHours = clampMoney(client.estimatedBookkeeperHours)
    }
    if ('estimatedAccountantHours' in client) {
      client.estimatedAccountantHours = clampMoney(client.estimatedAccountantHours)
    }
    if ('estimatedCfoHours' in client) {
      client.estimatedCfoHours = clampMoney(client.estimatedCfoHours)
    }
  }

  // Consolidated billing, resolved against this very payload. This is the one
  // place both backends pass through, and the file backend has no column to
  // resolve against at all — same reasoning as the lifecycle stage above.
  //
  // It CLEANS rather than refuses, deliberately: `write()` is the owner tab's
  // autosave, and a save that throws because a stale tab still remembers a
  // deleted master is the plan-refs outage wearing a new column. The create path
  // says the refusal out loud instead (see `billingLinkRefusal`).
  const billingLinks = sanitizeClientBillingLinks(data.clients)
  const dissolvedLinks = []
  for (const client of data.clients) {
    const links = billingLinks.get(client.id)
    if (!links) continue
    // THE GROUP-DISSOLVING AUTOSAVE. A payload that clears `isBillingMaster` on
    // the payer while its subs still point at it silently un-groups every one of
    // them — each link resolves to null and four companies quietly go back to
    // invoicing separately. Warned, not refused: the bulk save must never throw
    // (see below), and Railway's log is where the last outage was reconstructed
    // from. Same idiom as `filterBulkSaveOrphans`.
    const claimedBillTo =
      typeof client.billToClientId === 'string' && client.billToClientId
        ? client.billToClientId
        : null
    if (claimedBillTo && !links.billToClientId) {
      dissolvedLinks.push({ id: client.id, billToClientId: claimedBillTo })
    }
    // Guarded on PRESENCE, like the lifecycle stage above: this function's
    // contract is that a clean save passes through UNCHANGED, so a client that
    // never mentioned a bill-to must not come out of here having grown one.
    // Absence is given its meaning on the way back out, by the read mappers.
    if ('billToClientId' in client) client.billToClientId = links.billToClientId
    if ('isBillingMaster' in client) client.isBillingMaster = links.isBillingMaster
    if ('invoiceRecipientClientId' in client) {
      client.invoiceRecipientClientId = links.invoiceRecipientClientId
    }
    // "No data enterered or collected" — a master's estimates are not refused
    // here (see above), they are simply not kept. The Recap rolls its subs' own
    // estimates up; a number of its own would be double-counted in that sum.
    if (links.isBillingMaster) {
      for (const field of MASTER_ESTIMATE_FIELDS) {
        if (field in client) client[field] = undefined
      }
    }
  }
  if (dissolvedLinks.length > 0) {
    console.warn(
      `[bulk-save] dropped ${dissolvedLinks.length} bill-to link(s) — target missing or no longer a billing master:`,
      dissolvedLinks,
    )
  }

  for (const reimbursement of data.reimbursements) {
    reimbursement.amount = clampMoney(reimbursement.amount)
    dropInvalidDateField(reimbursement, 'date')
  }

  for (const recurring of data.recurringReimbursements) {
    recurring.amount = clampMoney(recurring.amount)
    dropInvalidDateField(recurring, 'startDate')
    // The covered-date fields go into `date`, `int` and `jsonb` columns, so a
    // malformed one is not a cosmetic problem: it fails the INSERT and takes
    // the whole bulk save down — every autosave, on Postgres only, while the
    // file backend accepts it and CI stays green. That is the shape of the
    // plan-refs outage, and this is the same guard that closed it.
    dropInvalidDateField(recurring, 'coverageStart')
    dropInvalidDateField(recurring, 'coverageEnd')
    if ('coverageAnchorDay' in recurring) {
      const anchor = Number(recurring.coverageAnchorDay)
      recurring.coverageAnchorDay =
        Number.isInteger(anchor) && anchor >= 1 && anchor <= 31 ? anchor : null
    }
    // An array is an object too, and `jsonb_set(… array[period] …)` on one would
    // behave in ways nobody intends. Only a plain map is a ledger.
    //
    // Guarded on PRESENCE, because this function's contract is that a clean
    // save passes through untouched — a record that never mentioned a ledger
    // must not come out of here having grown one. Absence is given its meaning
    // on the way back out, by `normalizeRecurringReimbursement`.
    if (
      'coverageHistory' in recurring &&
      (!recurring.coverageHistory ||
        typeof recurring.coverageHistory !== 'object' ||
        Array.isArray(recurring.coverageHistory))
    ) {
      recurring.coverageHistory = {}
    }
  }

  for (const entry of data.timeEntries) {
    // Seconds-precise, floored at 1 and capped — see coerceEntryMinutes. The
    // owner-tab bulk save re-inserts EVERY entry through here, so this line
    // decides the stored duration of the whole table on each autosave.
    entry.minutes = coerceEntryMinutes(entry.minutes)
    dropInvalidDateField(entry, 'date')
  }

  for (const checklist of data.checklists) {
    dropInvalidDateField(checklist, 'dueDate')
  }

  for (const template of data.checklistTemplates) {
    dropInvalidDateField(template, 'nextDueDate')
  }

  return data
}

/**
 * Drop rows from a bulk-save batch whose FK refs no longer exist in the
 * post-filter id sets. Pure function so it can be exercised in unit tests
 * without spinning up a DB pool. Returns the kept rows; logs the dropped
 * ones at warn level for Railway log forensics.
 *
 * IMPORTANT: `getRefs(row)` should only return ref kinds that map to
 * REAL foreign keys in the schema. Returning a ref for a plain text
 * column (no FK) will silently nuke valid rows for no benefit — that
 * was the bug that caused recycled-bin tombstones referencing missing
 * templates to vanish on autosave, which then let the materializer
 * respawn the deleted instance on the next read.
 */
export function filterBulkSaveOrphans(rows, { validClientIds, validTemplateIds, label, getRefs }) {
  if (!Array.isArray(rows)) return []
  const kept = []
  const dropped = []
  for (const row of rows) {
    const refs = getRefs(row) || {}
    const bad = []
    if (refs.clientId && !validClientIds.has(refs.clientId)) {
      bad.push({ kind: 'client', id: refs.clientId })
    }
    if (refs.templateId && validTemplateIds && !validTemplateIds.has(refs.templateId)) {
      bad.push({ kind: 'template', id: refs.templateId })
    }
    if (bad.length > 0) {
      dropped.push({ id: row?.id, bad })
    } else {
      kept.push(row)
    }
  }
  if (dropped.length > 0) {
    console.warn(`[bulk-save] dropped ${dropped.length} orphan ${label}:`, dropped)
  }
  return kept
}

/**
 * Filter a client's subscription-plan references down to plans that actually
 * exist (are being written in the same payload). Returns the FK-safe scalar
 * `planId` (derived from `planIds[0]` or the legacy `planId`, but only when it
 * still exists) and the cleaned `planIds` array.
 *
 * The `clients.plan_id` column has a foreign key to `subscription_plans`, but
 * the `plan_ids[]` array column does NOT — so a plan deleted while still listed
 * in a client's `plan_ids` leaves a dangling id behind. Because the scalar
 * `plan_id` is re-derived from `planIds[0]` on write, that dangling id would
 * violate the FK and abort the ENTIRE bulk write, 500-ing every read and taking
 * the whole app offline (this exact orphan caused a full outage on 2026-06-16).
 * This mirrors the FK's `on delete set null` intent so one orphaned reference
 * can never wedge the write again.
 *
 * @param {{ planIds?: unknown, planId?: unknown }} client
 * @param {Set<string>} validPlanIds - ids present in the payload's plans
 * @returns {{ planId: string | null, planIds: string[] }}
 */
export function sanitizeClientPlanRefs(client, validPlanIds) {
  const planIds = (Array.isArray(client?.planIds) ? client.planIds : []).filter(
    (id) => typeof id === 'string' && id && validPlanIds.has(id),
  )
  const legacy =
    Array.isArray(client?.planIds) && client.planIds.length > 0
      ? client.planIds[0]
      : client?.planId ?? null
  const planId = typeof legacy === 'string' && validPlanIds.has(legacy) ? legacy : null
  return { planId, planIds }
}

/**
 * Resolve every client's consolidated-billing links against the roster they are
 * written with, dropping any that do not hold.
 *
 * SAME DANGER AS `plan_ids`, and guarded the same way. `bill_to_client_id` and
 * `invoice_recipient_client_id` are plain text columns with NO foreign key, so a
 * dangling id sits there quietly until something reads it — and the last time an
 * FK-free client column held a reference to a row that no longer existed it
 * crashed every bulk write and took the whole app offline (2026-06-17; see
 * `sanitizeClientPlanRefs` above). Resolving on write means a stale tab that
 * still remembers a deleted master saves a null instead of a landmine.
 *
 * The rules, all of them one level deep by design (docs/plans/
 * consolidated-billing-2026-08.md §2, "Not in v1: more than one level of
 * bill-to"):
 *
 *   - `billToClientId` must name a client that EXISTS, is not this client, and
 *     is itself a billing master. Anything else resolves to null.
 *   - a MASTER may not be billed elsewhere — no chains, so a master's own
 *     `billToClientId` always resolves to null.
 *   - `invoiceRecipientClientId` is meaningful only on a master, and only when
 *     it names one of that master's own subs. It is which sub's contacts get the
 *     email, so a recipient that is not on the invoice is not a recipient.
 *
 * Pure, and roster-wide rather than per-client, because two of the three rules
 * are about OTHER rows. Returns a Map keyed by client id — apply, don't mutate.
 *
 * @param {Array<{id?: unknown, billToClientId?: unknown, isBillingMaster?: unknown, invoiceRecipientClientId?: unknown}>} clients
 * @returns {Map<string, {billToClientId: string|null, isBillingMaster: boolean, invoiceRecipientClientId: string|null}>}
 */
export function sanitizeClientBillingLinks(clients) {
  const rows = (Array.isArray(clients) ? clients : []).filter(
    (client) => client && typeof client.id === 'string' && client.id,
  )
  const masters = new Set(rows.filter((client) => client.isBillingMaster === true).map((c) => c.id))

  // Pass one: the bill-to link. A master's own link is dropped here, which is
  // what makes "no chains" a fact rather than a hope.
  const billTo = new Map()
  for (const client of rows) {
    const claimed =
      typeof client.billToClientId === 'string' && client.billToClientId
        ? client.billToClientId
        : null
    const resolved =
      claimed && claimed !== client.id && masters.has(claimed) && !masters.has(client.id)
        ? claimed
        : null
    billTo.set(client.id, resolved)
  }

  // Pass two: the recipient, which can only be judged once pass one has settled
  // who each master's subs actually are.
  const subsOf = new Map()
  for (const [id, target] of billTo) {
    if (!target) continue
    if (!subsOf.has(target)) subsOf.set(target, new Set())
    subsOf.get(target).add(id)
  }

  const out = new Map()
  for (const client of rows) {
    const isBillingMaster = masters.has(client.id)
    const claimedRecipient =
      typeof client.invoiceRecipientClientId === 'string' && client.invoiceRecipientClientId
        ? client.invoiceRecipientClientId
        : null
    const recipient =
      isBillingMaster && claimedRecipient && subsOf.get(client.id)?.has(claimedRecipient)
        ? claimedRecipient
        : null
    out.set(client.id, {
      billToClientId: billTo.get(client.id) ?? null,
      isBillingMaster,
      invoiceRecipientClientId: recipient,
    })
  }
  return out
}

/**
 * The same rules said out loud, for the paths where a PERSON is waiting on the
 * answer — `createClient` and the endpoints above it.
 *
 * The bulk save cannot throw (it re-inserts the whole workspace on every owner
 * autosave, and a save that 500s during month close is the outage this app has
 * already had once), so there it resolves a bad link to null instead. A single
 * deliberate create is the opposite case: silence there would leave someone
 * looking at a "Bills to KLC Master" field they set and the app did not keep.
 *
 * @returns {string|null} the sentence to refuse with, or null when it holds.
 */
export function billingLinkRefusal(client, roster) {
  const others = new Map(
    (Array.isArray(roster) ? roster : [])
      .filter((entry) => entry && typeof entry.id === 'string' && entry.id !== client?.id)
      .map((entry) => [entry.id, entry]),
  )
  const isMaster = client?.isBillingMaster === true
  const billTo =
    typeof client?.billToClientId === 'string' && client.billToClientId
      ? client.billToClientId
      : null
  const recipient =
    typeof client?.invoiceRecipientClientId === 'string' && client.invoiceRecipientClientId
      ? client.invoiceRecipientClientId
      : null

  if (billTo) {
    if (isMaster) {
      return 'A billing master issues the invoice, so it cannot itself be billed to another client.'
    }
    if (billTo === client?.id) return 'A client cannot be billed to itself.'
    const target = others.get(billTo)
    if (!target) return 'The client this one bills to is no longer on file.'
    if (target.isBillingMaster !== true) {
      return `${target.name ?? 'That client'} is not a billing master, so nothing can be billed to it.`
    }
  }

  if (recipient) {
    if (!isMaster) {
      return 'Only a billing master chooses which client its invoice is sent to.'
    }
    const sub = others.get(recipient)
    if (!sub || sub.billToClientId !== client?.id) {
      return 'The invoice recipient has to be one of this master\'s own sub clients.'
    }
  }

  if (isMaster && MASTER_ESTIMATE_FIELDS.some((field) => Number(client?.[field]) > 0)) {
    return 'A billing master holds no work of its own, so it cannot carry estimated hours.'
  }

  return null
}

/**
 * The estimate fields a billing master may not carry. Named once so the bulk
 * save's strip and `billingLinkRefusal`'s refusal can never drift apart.
 */
const MASTER_ESTIMATE_FIELDS = [
  'estimatedMonthlyHours',
  'estimatedBookkeeperHours',
  'estimatedAccountantHours',
  'estimatedCfoHours',
]

export function materializeRecurringChecklists(data) {
  const templates = Array.isArray(data.checklistTemplates) ? data.checklistTemplates : []
  if (templates.length === 0) {
    const backfill = backfillAssignedBookkeepers(data)
    if (backfill.changed) {
      return { changed: true, data: { ...data, clients: backfill.clients } }
    }
    return { changed: false, data }
  }

  const today = formatDateOnly(new Date())

  let changed = false
  const nextTemplates = templates.map((template) => {
    const migrated = ensureTemplateStages(template)
    if (!Array.isArray(template.stages) || template.stages.length === 0) {
      changed = true
    }
    return migrated
  })

  // Backfill case/stage fields on legacy checklist instances.
  const templatesById = new Map(nextTemplates.map((template) => [template.id, template]))
  const nextChecklists = (data.checklists ?? []).map((checklist) => {
    const next = { ...checklist }
    let mutated = false
    if (!next.caseId) {
      next.caseId = next.id
      mutated = true
    }
    if (typeof next.stageIndex !== 'number') {
      next.stageIndex = 0
      mutated = true
    }
    if (typeof next.stageCount !== 'number') {
      next.stageCount = 1
      mutated = true
    }
    if (!next.stageId && next.templateId) {
      const owningTemplate = templatesById.get(next.templateId)
      const firstStage = owningTemplate?.stages?.[0]
      if (firstStage) {
        next.stageId = firstStage.id
        next.stageCount = owningTemplate.stages.length
        mutated = true
      }
    }
    if (mutated) changed = true
    return next
  })

  // Treat recycled checklists as "already exists" so the materializer
  // doesn't keep re-spawning instances the user explicitly deleted. The
  // delete-then-comes-right-back symptom was caused by this set
  // considering only active checklists — a recycled checklist for the
  // current period wasn't here, so the next read materialized a fresh
  // duplicate and undid the delete. If the user wants the instance back,
  // they restore it from the recycle bin; otherwise we wait until the
  // template's nextDueDate advances and produce a new instance for the
  // next period naturally.
  //
  // Both key sets come from the SHARED identity module (lib/checklist-identity.js)
  // so this materializer, the browser-side backfill and the on-demand generate
  // endpoint can never drift into three slightly different notions of "already
  // exists" — which is how production collected 21 duplicate instance groups.
  const recycled = Array.isArray(data.recycledChecklists) ? data.recycledChecklists : []
  const { instanceKeys: existingKeys, monthKeys: existingMonthKeys } =
    buildChecklistInstanceKeys(nextChecklists, recycled)

  const todayDate = new Date()
  const currentYear = todayDate.getFullYear()
  // Retired clients stop producing NEW work. Their existing instances are
  // untouched above and stay visible forever; this only closes the tap.
  const retiredClients = inactiveClientIds(data.clients)

  for (const template of nextTemplates) {
    const stages = template.stages ?? []
    // Standard templates are blueprints only — they never materialize. A
    // specific-months template has no meaningful nextDueDate, so that guard is
    // skipped for it (handled in its own branch below).
    if (
      template.isStandard ||
      !template.active ||
      retiredClients.has(template.clientId) ||
      stages.length === 0 ||
      stages[0].items.length === 0 ||
      (template.frequency !== 'specific-months' && !template.nextDueDate)
    ) {
      continue
    }

    // Specific-months mode: ignore nextDueDate advance logic. For each
    // designated month of the current year that has started, generate a
    // Stage-1 instance unless one already exists for that template+month.
    if (template.frequency === 'specific-months') {
      // "Repeat every year" off: only generate for the year the template was
      // scheduled in. true/undefined behaves as today (every year).
      if (template.repeatAnnually === false && currentYear !== template.scheduleYear) {
        continue
      }
      const months = Array.isArray(template.scheduledMonths) ? template.scheduledMonths : []
      for (const month of months) {
        if (!Number.isInteger(month) || month < 1 || month > 12) continue
        const monthStart = new Date(currentYear, month - 1, 1)
        if (todayDate < monthStart) continue
        const stageOne = stages[0]
        // `resolveSpecificMonthsStageDueDate` is guaranteed to stay inside the
        // designated month, so the due date's YYYY-MM IS the per-month key.
        const stageOneDue = resolveSpecificMonthsStageDueDate(template, stageOne, currentYear, month)
        const monthKey = checklistMonthKey(template.id, stageOneDue)
        if (existingMonthKeys.has(monthKey)) continue
        // A designated month whose due date already passed is born completed
        // so the historical occurrence shows as finished; the current/future
        // month generates open exactly as before.
        const completed = stageOneDue < today
        const caseId = `case-${randomUUID().slice(0, 8)}`
        nextChecklists.push(
          buildChecklistFromStage({
            template,
            stage: stageOne,
            stageIndex: 0,
            stageCount: stages.length,
            caseId,
            dueDate: stageOneDue,
            completed,
          }),
        )
        existingMonthKeys.add(monthKey)
        existingKeys.add(checklistInstanceKey(template.id, stageOneDue, 0))
        changed = true
      }
      continue
    }

    // Lead time: surface an upcoming instance up to `leadDays` BEFORE its due
    // date so the team can start (and log time) early. This used to live ONLY
    // in the browser copy of the materializer, which meant the client generated
    // ahead of the server and then bulk-saved its own instance — the second
    // writer that produced the mixed-id duplicates. The server is now the
    // complete generator; the browser only backfills.
    const leadDays =
      typeof template.leadDays === 'number' && template.leadDays > 0
        ? Math.min(Math.floor(template.leadDays), 120)
        : 0
    const horizon = leadDays > 0 ? addDays(today, leadDays) : today

    let safetyCounter = 0
    while (template.nextDueDate <= horizon && safetyCounter < 60) {
      const stageOne = stages[0]
      const stageOneDue = resolveStageDueDate(stageOne, template.nextDueDate)
      // TWO keys, because the cycle date and the instance's stored due date are
      // not the same thing once stage 1 carries an `offsetDays` / `dueDayOfMonth`.
      // The old code checked the cycle key but the row it wrote back carried
      // `stageOneDue`, so the next run's key set never matched and the template
      // spawned another instance on the very same due date. Checking the due
      // date we are about to WRITE is what makes this actually idempotent.
      const cycleKey = checklistInstanceKey(template.id, template.nextDueDate, 0)
      const dueKey = checklistInstanceKey(template.id, stageOneDue, 0)

      if (!existingKeys.has(cycleKey) && !existingKeys.has(dueKey)) {
        const caseId = `case-${randomUUID().slice(0, 8)}`
        nextChecklists.push(
          buildChecklistFromStage({
            template,
            stage: stageOne,
            stageIndex: 0,
            stageCount: stages.length,
            caseId,
            dueDate: stageOneDue,
          }),
        )
        existingKeys.add(cycleKey)
        existingKeys.add(dueKey)
        changed = true
      }

      const advancedDueDate = advanceChecklistFrequency(template.nextDueDate, template.frequency)
      if (advancedDueDate === template.nextDueDate) {
        break
      }

      template.nextDueDate = advancedDueDate
      changed = true
      safetyCounter += 1
    }
  }

  const intermediateData = {
    ...data,
    checklistTemplates: nextTemplates,
    checklists: sortChecklists(nextChecklists),
  }
  const backfill = backfillAssignedBookkeepers(intermediateData)

  if (!changed && !backfill.changed) {
    return { changed: false, data }
  }

  return {
    changed: true,
    data: {
      ...intermediateData,
      clients: backfill.changed ? backfill.clients : intermediateData.clients,
    },
  }
}

/**
 * Pure mapping for the onboarding case ↔ client lifecycle sync. Given the
 * checklist whose stage just advanced/completed, returns the lifecycle stage
 * the client should be moved to — or null when nothing should change.
 *
 *   - `spawned` truthy (a NEXT stage was just materialised): map the SPAWNED
 *     stage index — 0 ⇒ 'proposal', 1 ⇒ 'onboarding', anything beyond ⇒
 *     'active' (defensive; the final stage is the last one).
 *   - no spawn but the FINAL stage just completed (every item done and
 *     stageIndex+1 >= stageCount): the case is finished ⇒ 'active'.
 *   - otherwise (e.g. a mid-stage toggle that didn't advance): null.
 *
 * Returns null unless `checklist.onboardingForClientId` is set, so the sync is
 * a strict no-op for every normal (non-onboarding) case.
 */
export function onboardingStageForSync(checklist, spawned) {
  if (!checklist || !checklist.onboardingForClientId) return null
  if (spawned) {
    const idx = typeof spawned.stageIndex === 'number' ? spawned.stageIndex : 0
    if (idx <= 0) return 'proposal'
    if (idx === 1) return 'onboarding'
    return 'active'
  }
  const stageCount = typeof checklist.stageCount === 'number' ? checklist.stageCount : 1
  const stageIndex = typeof checklist.stageIndex === 'number' ? checklist.stageIndex : 0
  const allItemsDone =
    Array.isArray(checklist.items) &&
    checklist.items.length > 0 &&
    checklist.items.every((item) => item.done)
  if (allItemsDone && stageIndex + 1 >= stageCount) return 'active'
  return null
}

/**
 * Forward-only stage progression. When `justCompletedChecklist` represents the
 * final state of a stage instance whose every item is done, materialise the
 * next stage as a fresh checklist instance. Returns the spawned checklist (if
 * any). The caller guards against double-spawn by checking for an existing
 * checklist with the same caseId/stageIndex+1 in the current data set.
 */
function buildSpawnedNextStageChecklist({ template, justCompletedChecklist }) {
  const stages = template?.stages ?? []
  if (stages.length === 0) return null
  const currentStageIndex = typeof justCompletedChecklist.stageIndex === 'number'
    ? justCompletedChecklist.stageIndex
    : 0
  const nextStageIndex = currentStageIndex + 1
  if (nextStageIndex >= stages.length) return null
  const nextStage = stages[nextStageIndex]
  if (!nextStage || (nextStage.items ?? []).length === 0) return null
  // An explicit per-stage dueDate wins over the offsetDays calculation.
  const dueDate = resolveStageDueDate(nextStage, justCompletedChecklist.dueDate)
  return buildChecklistFromStage({
    template,
    stage: nextStage,
    stageIndex: nextStageIndex,
    stageCount: stages.length,
    caseId: justCompletedChecklist.caseId || justCompletedChecklist.id,
    dueDate,
  })
}

/**
 * One shape for a skip record whichever backend produced it. Timestamps are ISO
 * strings on both sides (pg hands back Date objects, the file backend already
 * stores strings), and `reviewedAt` being null is the whole dashboard filter.
 */
function mapChecklistSkipRow(row) {
  return {
    id: row.id,
    checklistId: row.checklist_id,
    templateId: row.template_id ?? null,
    clientId: row.client_id ?? null,
    title: row.title ?? '',
    skippedBy: row.skipped_by ?? null,
    skippedByName: row.skipped_by_name ?? null,
    skippedAt: row.skipped_at ? new Date(row.skipped_at).toISOString() : null,
    reasonCategory: row.reason_category,
    reasonNote: row.reason_note ?? '',
    reviewedBy: row.reviewed_by ?? null,
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
  }
}

/** The file backend's stored object, filled out to the same shape. */
function normalizeChecklistSkip(record) {
  return {
    id: record.id,
    checklistId: record.checklistId,
    templateId: record.templateId ?? null,
    clientId: record.clientId ?? null,
    title: record.title ?? '',
    skippedBy: record.skippedBy ?? null,
    skippedByName: record.skippedByName ?? null,
    skippedAt: record.skippedAt ?? null,
    reasonCategory: record.reasonCategory,
    reasonNote: record.reasonNote ?? '',
    reviewedBy: record.reviewedBy ?? null,
    reviewedAt: record.reviewedAt ?? null,
  }
}

export class AppDataStore {
  constructor() {
    this.pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null
    this.mode = this.pool ? 'postgres' : 'file'
  }

  async initialize() {
    if (this.pool) {
      await this.pool.query(`
        create table if not exists users (
          id text primary key,
          name text not null,
          email text unique,
          role text not null check (role in ('owner', 'bookkeeper', 'senior_bookkeeper')),
          staff_role text not null,
          password_hash text not null,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `)

      await this.pool.query(`alter table users add column if not exists magic_token text`)
      await this.pool.query(`alter table users add column if not exists token_revoked_at timestamptz`)
      await this.pool.query(`alter table users add column if not exists last_active_at timestamptz`)
      // SECURITY (M4): timestamp of when the user last set their OWN password.
      // Null = they have never set one (still on the seed/random default), so
      // the change-password endpoint lets them set a first password with just
      // a valid session. Non-null = a current-password challenge is required
      // before the password can be changed, so a hijacked session can't
      // silently lock the real user out. Additive, backfills as null.
      await this.pool.query(`alter table users add column if not exists password_set_at timestamptz`)
      // Soft-delete marker for team members. Null = active. Non-null =
      // owner removed them; they can no longer sign in or be assigned new
      // work, but their historical time entries / completed checklists
      // stay attributed for analytics. See `deleteTeamMember`.
      await this.pool.query(`alter table users add column if not exists inactive_at timestamptz`)
      // Owner-controlled team-roster order. Null until first reorder/backfill.
      // The backfill seeds any missing values with the previous default order
      // (owners first, then name) and appends freshly-invited users after the
      // current max — so an explicit order set on the Team page survives reboots
      // and is never clobbered.
      await this.pool.query(`alter table users add column if not exists sort_order int`)
      await this.pool.query(`
        update users u
        set sort_order = sub.rn
        from (
          select id,
                 (select coalesce(max(sort_order), -1) from users)
                   + row_number() over (
                       order by case when role = 'owner' then 0 else 1 end, name asc
                     ) as rn
          from users
          where sort_order is null
        ) sub
        where u.id = sub.id and u.sort_order is null
      `)
      await this.pool.query(`
        create unique index if not exists users_magic_token_unique on users (magic_token)
        where magic_token is not null
      `)

      await this.pool.query(`
        create table if not exists activity_log (
          id text primary key,
          user_id text not null,
          action text not null,
          target text not null default '',
          created_at timestamptz not null default now()
        )
      `)
      await this.pool.query(`
        create index if not exists activity_log_user_idx on activity_log (user_id, created_at desc)
      `)

      await this.pool.query(`
        create table if not exists sessions (
          id text primary key,
          user_id text not null references users(id) on delete cascade,
          expires_at timestamptz not null,
          created_at timestamptz not null default now()
        )
      `)

      // Firm-wide branding/settings (singleton row).
      await this.pool.query(`
        create table if not exists firm_settings (
          id text primary key default 'singleton',
          name text not null default 'PB&J Strategic Accounting',
          tagline text,
          logo_url text,
          brand_color text default '#3c2044',
          address_line1 text,
          address_line2 text,
          city text,
          state text,
          postal_code text,
          phone text,
          email text,
          website text,
          ein text,
          updated_at timestamptz not null default now(),
          check (id = 'singleton')
        )
      `)
      await this.pool.query(`
        insert into firm_settings (id, name)
        values ('singleton', 'PB&J Strategic Accounting')
        on conflict (id) do nothing
      `)

      // Sidebar text color setting — added later so existing DBs need
      // an in-place column add. Default to white so the sidebar text
      // stays legible against the (originally plum) brand color until
      // the owner picks a custom value.
      await this.pool.query(
        `alter table firm_settings add column if not exists sidebar_text_color text default '#ffffff'`,
      )
      // Active nav-item color (distinct from the regular sidebar text
      // color) so the currently-open page can pop against the rest of
      // the sidebar. Defaults to white so legacy deployments look the
      // same until the owner picks a custom value.
      await this.pool.query(
        `alter table firm_settings add column if not exists sidebar_active_text_color text default '#ffffff'`,
      )
      // Owner-configurable defaults for the Add-client form (house rate,
      // payment terms, invoice prefs, etc.). Stored as JSON so it's easy to
      // extend without a column per field. Additive + idempotent.
      await this.pool.query(
        `alter table firm_settings add column if not exists client_defaults jsonb`,
      )

      // Phase 5: notifications (in-app bell + email-ready).
      await this.pool.query(`
        create table if not exists notifications (
          id text primary key,
          user_id text not null,
          event text not null,
          message text not null,
          link text,
          payload jsonb,
          read_at timestamptz,
          created_at timestamptz not null default now()
        )
      `)
      await this.pool.query(`alter table notifications add column if not exists link text`)
      await this.pool.query(`alter table notifications add column if not exists payload jsonb`)
      await this.pool.query(`alter table notifications add column if not exists read_at timestamptz`)
      await this.pool.query(`
        create index if not exists notifications_user_idx on notifications(user_id, created_at desc)
      `)

      // Email-gated authentication: short-lived sign-in link tokens (single-use, 15 min).
      await this.pool.query(`
        create table if not exists login_tokens (
          token text primary key,
          user_id text not null,
          expires_at timestamptz not null,
          consumed_at timestamptz,
          ip_address text,
          created_at timestamptz not null default now()
        )
      `)
      await this.pool.query(`
        create index if not exists login_tokens_user_idx on login_tokens(user_id)
      `)

      // Email-gated authentication: persistent user sessions (30-day sliding expiry).
      await this.pool.query(`
        create table if not exists user_sessions (
          id text primary key,
          user_id text not null,
          created_at timestamptz not null default now(),
          last_seen_at timestamptz not null default now(),
          revoked_at timestamptz,
          user_agent text,
          ip_address text
        )
      `)
      await this.pool.query(`
        create index if not exists user_sessions_user_idx on user_sessions(user_id)
      `)

      // Feature requests the owner sends to the developer via the AI
      // assistant. The in-app record is the source of truth; the email is
      // best-effort delivery on top.
      await this.pool.query(`
        create table if not exists feature_requests (
          id text primary key,
          user_id text not null,
          title text not null,
          description text not null,
          status text not null default 'sent',
          created_at timestamptz not null default now()
        )
      `)
      // Owner-only "Updates" tracker fields (Feature D). Idempotent so the
      // existing assistant-drafted rows pick up sensible defaults:
      //  - type:          feature | bug | improvement
      //  - urgent:        pins an item to the top of the backlog
      //  - priority_rank: drag-to-rank order (lower = nearer the top)
      //  - dev_notes:     optional owner notes carried into the copy block
      //  - updated_at:    last-edit stamp (null for never-edited legacy rows)
      // The legacy status default ('sent') is read-mapped to 'new'.
      await this.pool.query(
        `alter table feature_requests add column if not exists type text not null default 'feature'`,
      )
      await this.pool.query(
        `alter table feature_requests add column if not exists urgent boolean not null default false`,
      )
      // 4-level priority (urgent | high | medium | low). Replaces the binary
      // `urgent` flag — the old column is kept for back-compat but no longer
      // read/written. Backfill once: rows still at the default ('medium') whose
      // legacy `urgent` flag was set become 'urgent'. Guarded so it never
      // clobbers a level the owner has since chosen.
      await this.pool.query(
        `alter table feature_requests add column if not exists priority text not null default 'medium'`,
      )
      await this.pool.query(
        `update feature_requests set priority = 'urgent' where urgent = true and priority = 'medium'`,
      )
      await this.pool.query(
        `alter table feature_requests add column if not exists priority_rank integer not null default 0`,
      )
      await this.pool.query(
        `alter table feature_requests add column if not exists dev_notes text`,
      )
      await this.pool.query(
        `alter table feature_requests add column if not exists updated_at timestamptz`,
      )
      // Approval audit: who approved (moved to 'done') and when. Stamped when an
      // item becomes 'done'; cleared when it moves away from 'done'. Null on
      // legacy done rows that predate this.
      await this.pool.query(
        `alter table feature_requests add column if not exists approved_by text`,
      )
      await this.pool.query(
        `alter table feature_requests add column if not exists approved_at timestamptz`,
      )
      // Rejection audit: when the owner clicks "Not approved" on a shipped item
      // it goes back to 'in_progress' carrying the reason note + reviewer id +
      // timestamp (mirrors approved_by/approved_at). Stamped when a non-empty
      // review_note is set; cleared when the item is re-shipped or approved.
      await this.pool.query(
        `alter table feature_requests add column if not exists review_note text`,
      )
      await this.pool.query(
        `alter table feature_requests add column if not exists reviewed_by text`,
      )
      await this.pool.query(
        `alter table feature_requests add column if not exists reviewed_at timestamptz`,
      )

      // Clarification loop: when the developer can't build an item without an
      // answer, it moves to status 'needs_input' with clarification_question
      // set. The owner answers from the Updates page ("Needs your answer"
      // section) — the answer is stored and the item returns to 'planned'.
      await this.pool.query(
        `alter table feature_requests add column if not exists clarification_question text`,
      )
      await this.pool.query(
        `alter table feature_requests add column if not exists clarification_answer text`,
      )

      // When the item last moved to 'shipped' — shown next to the title on the
      // Updates page so the owner sees exactly when a change went live.
      // Re-stamped on every transition INTO shipped (a re-ship shows its new
      // time). One-time backfill: items already shipped borrow updated_at,
      // their last touch (idempotent — only fills NULLs on shipped rows).
      await this.pool.query(
        `alter table feature_requests add column if not exists shipped_at timestamptz`,
      )
      await this.pool.query(
        `update feature_requests set shipped_at = coalesce(updated_at, created_at)
          where status = 'shipped' and shipped_at is null`,
      )

      // Assistant suggestions the owner dismissed — keyed by a stable
      // pattern key so the same suggestion never nags twice.
      await this.pool.query(`
        create table if not exists assistant_dismissed_suggestions (
          user_id text not null,
          suggestion_key text not null,
          dismissed_at timestamptz not null default now(),
          primary key (user_id, suggestion_key)
        )
      `)

      // Persisted assistant conversation (Phase 3). One row per turn so the
      // owner's chat history survives reloads and follows her across devices.
      // Only role + text are stored — ephemeral feature-request drafts and
      // action proposals are NOT persisted (they shouldn't re-fire on reload).
      await this.pool.query(`
        create table if not exists assistant_messages (
          id text primary key,
          user_id text not null,
          role text not null,
          text text not null,
          created_at timestamptz not null default now()
        )
      `)
      await this.pool.query(
        `create index if not exists assistant_messages_user_idx
           on assistant_messages (user_id, created_at)`,
      )

      // Weekly-digest bookkeeping (Phase 3): one row per user recording the
      // ISO week (yyyy-mm-dd Monday) of the last digest sent, so the daily
      // scheduler never emails the same week's digest twice.
      await this.pool.query(`
        create table if not exists assistant_digest_state (
          user_id text primary key,
          last_week_start text not null,
          updated_at timestamptz not null default now()
        )
      `)

      // Voice agent cross-call memory (voice V2): durable facts the owner
      // tells the voice assistant ("remember that…"), recalled on later calls
      // and injected as a digest at session start.
      await this.pool.query(`
        create table if not exists voice_memories (
          id text primary key,
          user_id text not null,
          fact text not null,
          source text not null default 'voice',
          created_at timestamptz not null default now()
        )
      `)

      // Voice call transcripts (voice V2): summary + turns delivered by the
      // ElevenLabs post-call webhook, kept for history (trimmed to last 50).
      await this.pool.query(`
        create table if not exists voice_transcripts (
          id text primary key,
          conversation_id text not null,
          summary text not null default '',
          transcript text not null default '[]',
          created_at timestamptz not null default now()
        )
      `)

      // "Just spitballing" brainstorm sessions (Britt's Brain). The modal used
      // to hold the whole conversation in React state, so closing the window
      // destroyed it and every new session started from nothing. One ACTIVE
      // session per user lives here instead: it survives close/reopen, follows
      // her across devices, and once archived its `summary` feeds the NEXT
      // session's context ("like we talked about last time").
      //
      // Endpoint-managed and deliberately OUT of the bulk /api/app-data payload
      // AND out of the staleness fingerprint — exactly like `invoices` (see
      // docs/plans/invoicing-handoff.md "Things that will bite you" #3). A stale
      // owner tab must never rewrite a conversation, and a live brainstorm must
      // never invalidate her other tabs for writes.
      //
      // `user_id` is a plain text column with NO foreign key, matching the other
      // user-scoped side tables (assistant_messages, voice_memories), so this
      // table sits entirely outside the clients-wipe FK dance in `write()`.
      await this.pool.query(`
        create table if not exists spitball_sessions (
          id text primary key,
          user_id text not null,
          status text not null default 'active',
          messages jsonb not null default '[]'::jsonb,
          summary text,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `)
      // PARTIAL unique — at most one ACTIVE session per user, while any number
      // of archived ones coexist. Same shape (and same reasoning) as
      // `invoices_client_period_live`; the one-active rule is enforced by the
      // index rather than by hope.
      await this.pool.query(`
        create unique index if not exists spitball_sessions_one_active
          on spitball_sessions (user_id)
          where status = 'active'
      `)
      await this.pool.query(
        `create index if not exists spitball_sessions_user_idx
           on spitball_sessions (user_id, updated_at)`,
      )

      // Sales-tax figures recorded per client + period (Client Recap page).
      // Owner-only financial data, deliberately endpoint-managed (NOT part of
      // the bulk /api/app-data wipe-and-reinsert) so it can't be clobbered.
      // `period` is the recap key: "2026-08" (monthly) or "2026-Q3" (quarterly).
      // The recap also has a "2026" (yearly) key shape, and it is deliberately
      // NOT accepted here — sales tax is filed monthly or quarterly, so a
      // year-keyed figure would be a number with no filing behind it. The PUT
      // route in server.js rejects periodType 'year' for exactly that reason.
      await this.pool.query(`
        create table if not exists sales_tax_records (
          id text primary key,
          client_id text not null,
          period text not null,
          taxable_sales numeric,
          tax_collected numeric,
          tax_owed numeric,
          notes text not null default '',
          updated_by text,
          updated_at timestamptz not null default now(),
          unique (client_id, period)
        )
      `)

      // Per-client notes log: a timestamped, attributed, append-only history.
      // Owner AND a client's assigned staff can view + add. Deliberately
      // endpoint-managed (NOT part of the bulk /api/app-data wipe-and-reinsert)
      // — exactly like sales_tax_records — so staff can write notes without the
      // owner-only bulk save, and so notes can never be clobbered by an autosave.
      await this.pool.query(`
        create table if not exists client_notes (
          id text primary key,
          client_id text not null,
          author_id text,
          author_name text,
          body text not null,
          created_at timestamptz not null default now()
        )
      `)
      await this.pool.query(
        `create index if not exists client_notes_client_idx on client_notes (client_id)`,
      )

      // Item-level deletion requests: a NON-owner asks to delete a single
      // checklist item / sub-item / sub-sub-item; nothing is removed until an
      // owner approves. Endpoint-managed (NOT part of the bulk app-data write)
      // — exactly like client_notes / sales_tax_records — so staff can file a
      // request without the owner-only bulk save, and so requests can't be
      // clobbered by an autosave. Plain text ids (no FK) so the row survives
      // even if the target item is edited; `label` snapshots the text.
      await this.pool.query(`
        create table if not exists item_deletion_requests (
          id text primary key,
          client_id text not null,
          checklist_id text not null,
          item_id text not null,
          sub_item_id text,
          sub_sub_item_id text,
          label text not null,
          requested_by text,
          requested_by_name text,
          requested_at timestamptz not null default now()
        )
      `)
      await this.pool.query(
        `create index if not exists item_deletion_requests_checklist_idx on item_deletion_requests (checklist_id)`,
      )

      // Active Checklists board: per-template/per-checklist service category
      // (the board's columns) + the categories table itself. The column is a
      // plain text id (NOT a FK) so deleting a category leaves rows readable as
      // "Uncategorized". Seeded below when the table is empty.
      await this.pool.query(`alter table checklists add column if not exists category_id text`)
      await this.pool.query(
        `alter table checklist_templates add column if not exists category_id text`,
      )
      // DUPLICATE-INSTANCE BACKSTOP.
      //
      // The materializer's idempotency was check-then-insert with nothing
      // underneath it, so two simultaneous `GET /api/app-data` reads could each
      // decide a period had no instance yet and each create one. Production
      // collected 21 groups of ACTIVE checklists sharing an identical
      // (template_id, due_date, stage_index). This UNIQUE partial index makes
      // that physically impossible.
      //
      // Why the tuple is (template_id, due_date, stage_index) and not a month
      // key: a weekly template legitimately has four instances inside one month.
      // The due date is the finest identity that is still stable across runs.
      // `deleted_at is null` keeps the recycle bin out of it (a restored-then-
      // re-deleted instance must not collide), and `template_id is not null`
      // leaves one-off manual checklists completely alone.
      //
      // WHY THIS IS WRAPPED IN try/catch: production still contains the 21
      // duplicate groups today — the cleanup write is scheduled for AFTER this
      // deploys. `create unique index` would fail on that dirty data and, since
      // initialize() is the boot path, an unguarded throw would take the whole
      // app down. So we attempt it on every boot and log loudly when it can't
      // be built yet; the first boot after the cleanup lands creates it and the
      // backstop arms itself with no further deploy. Each statement here runs
      // in its own implicit transaction, so a failure leaves nothing poisoned.
      // Until then the shared in-code guard (lib/checklist-identity.js) is what
      // prevents new duplicates.
      try {
        await this.pool.query(`
          create unique index if not exists ${CHECKLIST_INSTANCE_UNIQUE_INDEX}
            on checklists (template_id, due_date, stage_index)
            where deleted_at is null and template_id is not null
        `)
      } catch (error) {
        console.warn(
          `[init] could not create ${CHECKLIST_INSTANCE_UNIQUE_INDEX} — most likely duplicate ` +
            `(template_id, due_date, stage_index) rows still present. New duplicates are still ` +
            `blocked in code; this will be retried on the next boot. Reason:`,
          error && error.message ? error.message : error,
        )
      }

      // Templates cloned from another template stamp their origin id so the UI
      // can tell a plan's checklist is "already set up" on a client. Plain text
      // id, no FK (the source may later be deleted).
      await this.pool.query(
        `alter table checklist_templates add column if not exists source_template_id text`,
      )
      await this.pool.query(`
        create table if not exists service_categories (
          id text primary key,
          name text not null,
          sort_order int not null default 0,
          updated_at timestamptz not null default now()
        )
      `)
      const existingCategories = await this.pool.query(
        `select count(*)::int as n from service_categories`,
      )
      if ((existingCategories.rows[0]?.n ?? 0) === 0) {
        for (const [index, name] of SEED_SERVICE_CATEGORIES.entries()) {
          await this.pool.query(
            `insert into service_categories (id, name, sort_order, updated_at)
             values ($1, $2, $3, now())`,
            [`cat-${randomUUID().slice(0, 8)}`, name, index],
          )
        }
      }

      // TOTP two-factor: per-user secret + enable flag + backup codes.
      // Stored as plaintext for v1 — encryption-at-rest at the DB layer is
      // the right defense (see lib/totp.js header). Backup codes are stored
      // pre-hashed (sha-256) so a DB read alone does not yield usable codes.
      // Optional per-employee cost/pay rate (assistant Phase 4). Owner-only,
      // informational — it powers the assistant's margin analytics and NEVER
      // affects invoices (same rule as estimated hours). Null = not set.
      await this.pool.query(`alter table users add column if not exists cost_rate numeric`)
      // Per-user EMAIL notification toggles (sparse map of prefKey -> boolean;
      // missing key = enabled). See lib/notification-prefs.js.
      await this.pool.query(`alter table users add column if not exists email_notification_prefs jsonb`)
      // Per-employee BILL rate ($/hour charged to clients for this person's
      // time). Separate from cost_rate (a cost/pay rate, margin-only). Unlike
      // cost_rate, bill_rate DOES feed invoices: hourly clients are billed off
      // each employee's bill_rate (see getInvoice). Owner-only, nullable.
      await this.pool.query(`alter table users add column if not exists bill_rate numeric`)
      await this.pool.query(`alter table users add column if not exists totp_secret text`)
      await this.pool.query(`alter table users add column if not exists totp_enabled boolean not null default false`)
      await this.pool.query(`alter table users add column if not exists totp_backup_codes text[] not null default '{}'`)
      await this.pool.query(`alter table users add column if not exists pending_totp_secret text`)

      // TOTP two-factor: short-lived pending tokens (5 min) used between
      // /verify/:token and /two-factor (or /two-factor/setup). One-shot.
      await this.pool.query(`
        create table if not exists pending_two_factor (
          token text primary key,
          user_id text not null,
          requires_setup boolean not null default false,
          attempts int not null default 0,
          locked_at timestamptz,
          expires_at timestamptz not null,
          consumed_at timestamptz,
          created_at timestamptz not null default now()
        )
      `)
      await this.pool.query(`
        create index if not exists pending_two_factor_user_idx on pending_two_factor(user_id)
      `)

      await this.pool.query(`
        create table if not exists subscription_plans (
          id text primary key,
          name text not null,
          monthly_fee numeric(12, 2) not null,
          included_hours numeric(8, 2) not null default 0,
          notes text not null default '',
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `)

      // Pricing left the plan model — a plan is now just name + notes. The
      // legacy `monthly_fee` / `included_hours` columns are KEPT (not dropped)
      // so the billing migration below can still read each client's old plan
      // fee, but we stop reading/writing them. Relax their NOT NULL +
      // backfill a default so inserts that omit them succeed on every DB.
      await this.pool.query(
        `alter table subscription_plans alter column monthly_fee drop not null`,
      )
      await this.pool.query(
        `alter table subscription_plans alter column monthly_fee set default 0`,
      )
      await this.pool.query(
        `alter table subscription_plans alter column included_hours drop not null`,
      )

      // Plans bundle a set of checklist TEMPLATES (by id). No FK — a template
      // can be deleted while still listed here, so reads coerce to []/string[]
      // and the apply flow only acts on templates that still exist. Mirrors the
      // FK-free `clients.plan_ids[]` idiom.
      await this.pool.query(
        `alter table subscription_plans add column if not exists template_ids text[] not null default '{}'`,
      )

      // Reusable contacts (shared across clients). Mirrors the plans/clients
      // table idioms incl. `updated_at`. Selected on clients via `contact_ids`.
      await this.pool.query(`
        create table if not exists contacts (
          id text primary key,
          name text not null,
          email text,
          phone text,
          title text,
          notes text,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `)
      // Per-contact lock (read-only protection) — shared + persisted.
      await this.pool.query(
        `alter table contacts add column if not exists locked boolean not null default false`,
      )
      // Per-company email overrides (array-of-objects → jsonb, NOT text[]).
      await this.pool.query(
        `alter table contacts add column if not exists company_emails jsonb not null default '[]'`,
      )
      // Symmetric links to other contacts.
      await this.pool.query(
        `alter table contacts add column if not exists linked_contact_ids text[] not null default '{}'`,
      )
      // Archive marker (null = active).
      await this.pool.query(
        `alter table contacts add column if not exists archived_at timestamptz`,
      )
      // Optional named group (`group` is a SQL reserved word → column is
      // `group_name`). Null/empty = ungrouped.
      await this.pool.query(
        `alter table contacts add column if not exists group_name text`,
      )

      await this.pool.query(`
        create table if not exists clients (
          id text primary key,
          name text not null,
          contact text not null,
          billing_mode text not null check (billing_mode in ('hourly', 'subscription', 'annual')),
          hourly_rate numeric(12, 2) not null,
          plan_id text references subscription_plans(id) on delete set null,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `)

      await this.pool.query(`alter table clients add column if not exists email text`)
      await this.pool.query(`alter table clients add column if not exists contact_name text`)
      await this.pool.query(`alter table clients add column if not exists phone text`)
      await this.pool.query(`alter table clients add column if not exists address_line1 text`)
      await this.pool.query(`alter table clients add column if not exists address_line2 text`)
      await this.pool.query(`alter table clients add column if not exists city text`)
      await this.pool.query(`alter table clients add column if not exists state text`)
      await this.pool.query(`alter table clients add column if not exists postal_code text`)
      await this.pool.query(`alter table clients add column if not exists logo_url text`)
      await this.pool.query(`alter table clients add column if not exists payment_terms text`)
      await this.pool.query(`alter table clients add column if not exists footer_note text`)
      await this.pool.query(`alter table clients add column if not exists quickbooks_pay_url text`)
      // Per-client override of the subscription plan's monthly fee — used
      // when the client negotiates a custom rate. Nullable: a null value
      // means "use the plan's default fee".
      await this.pool.query(
        `alter table clients add column if not exists custom_monthly_fee numeric(12, 2)`,
      )
      await this.pool.query(
        `alter table clients add column if not exists invoice_show_time_breakdown boolean not null default true`,
      )
      // The time breakdown, as Brittany asked for it on 2026-08-25: OFF for
      // everyone until she turns it on, and then at a detail level she picks per
      // client. Defaulting 'off' is what makes this need no data migration —
      // every existing row is already where she wants it, and the older boolean
      // above is left alone rather than rewritten under 48 live clients.
      await this.pool.query(
        `alter table clients add column if not exists invoice_time_breakdown_mode text not null default 'off'`,
      )
      await this.pool.query(
        `alter table clients add column if not exists invoice_time_breakdown_amounts boolean not null default false`,
      )
      await this.pool.query(
        `alter table clients add column if not exists invoice_hide_internal_hours boolean not null default true`,
      )
      await this.pool.query(
        `alter table clients add column if not exists invoice_group_by_category boolean not null default false`,
      )
      // Per-client card payments. Default FALSE deliberately: every existing
      // client keeps bank transfer only, and card is something a person turns on
      // for one client at a time after agreeing the client covers the fee.
      await this.pool.query(
        `alter table clients add column if not exists card_payments_enabled boolean not null default false`,
      )
      await this.pool.query(
        `alter table clients add column if not exists assigned_bookkeeper_ids text[] not null default '{}'`,
      )

      // Billing refactor: a client is now either Hourly (hourly_rate) OR
      // Monthly (its own monthly_rate, replacing the plan-derived fee +
      // per-client override). `estimated_monthly_hours` is INFORMATIONAL
      // ONLY and must never affect invoice totals. A client can subscribe to
      // MULTIPLE plans/services (`plan_ids`) and have MULTIPLE contacts
      // (`contact_ids`). All additive + nullable so legacy rows keep working.
      await this.pool.query(
        `alter table clients add column if not exists monthly_rate numeric(12, 2)`,
      )
      await this.pool.query(
        `alter table clients add column if not exists estimated_monthly_hours numeric(8, 2)`,
      )
      // Per-role estimated hours (informational only) — replace the single
      // estimated_monthly_hours field. Additive + nullable so legacy rows
      // keep working; the read-map surfaces the legacy value as the
      // bookkeeper hours when all three are absent.
      await this.pool.query(
        `alter table clients add column if not exists estimated_bookkeeper_hours numeric`,
      )
      await this.pool.query(
        `alter table clients add column if not exists estimated_accountant_hours numeric`,
      )
      await this.pool.query(
        `alter table clients add column if not exists estimated_cfo_hours numeric`,
      )
      await this.pool.query(
        `alter table clients add column if not exists plan_ids text[] not null default '{}'`,
      )
      await this.pool.query(
        `alter table clients add column if not exists contact_ids text[] not null default '{}'`,
      )
      // Named monthly service package (e.g. "The Classic") for subscription
      // clients — drives the invoice line label. Additive + nullable.
      await this.pool.query(
        `alter table clients add column if not exists monthly_service_tier text`,
      )
      // Annual billing: a flat yearly fee billed ONCE per year in a chosen
      // month. Additive + nullable so legacy rows keep working. The existing
      // billing_mode CHECK constraint only allowed hourly/subscription — drop
      // and re-add it (idempotently, every boot) so 'annual' is permitted on
      // databases created before this mode existed.
      await this.pool.query(
        `alter table clients drop constraint if exists clients_billing_mode_check`,
      )
      await this.pool.query(
        `alter table clients add constraint clients_billing_mode_check check (billing_mode in ('hourly', 'subscription', 'annual'))`,
      )
      await this.pool.query(
        `alter table clients add column if not exists annual_rate numeric(12, 2)`,
      )
      await this.pool.query(
        `alter table clients add column if not exists annual_billing_month integer`,
      )
      // Consolidated billing (featreq-65f5eac1): one invoice to a BILLING
      // MASTER carrying several companies' work. All three additive and
      // nullable/defaulted, so every existing row is already correct — an
      // ordinary client bills itself, is not a master, and names no recipient.
      // NO foreign key on either id column, by the same reasoning as
      // `plan_ids`: they are resolved on write (`sanitizeClientBillingLinks`)
      // rather than enforced by the database, because an FK violation inside the
      // bulk save aborts the whole transaction and takes every read down with it.
      await this.pool.query(
        `alter table clients add column if not exists bill_to_client_id text`,
      )
      await this.pool.query(
        `alter table clients add column if not exists is_billing_master boolean not null default false`,
      )
      await this.pool.query(
        `alter table clients add column if not exists invoice_recipient_client_id text`,
      )

      // Onboarding lifecycle stage (Proposal → Onboarding → Active). NOT NULL
      // default 'active' so the firm's existing clients stay active — no client
      // silently becomes a prospect. Additive + idempotent.
      await this.pool.query(
        `alter table clients add column if not exists lifecycle_stage text not null default 'active'`,
      )

      // BILLING-CRITICAL MIGRATION — preserve every client's current
      // effective monthly amount before pricing left the plan. Guarded on
      // null so re-runs / row reorders never clobber an owner's edits.
      //
      //   monthly_rate ← coalesce(custom_monthly_fee, <old plan's monthly_fee>)
      //   plan_ids     ← [plan_id] when a legacy plan_id exists, else {}
      await this.pool.query(`
        update clients c
        set monthly_rate = coalesce(
          c.custom_monthly_fee,
          (select p.monthly_fee from subscription_plans p where p.id = c.plan_id)
        )
        where c.monthly_rate is null
          and (
            c.custom_monthly_fee is not null
            or c.plan_id is not null
          )
      `)
      await this.pool.query(`
        update clients c
        set plan_ids = case
          when c.plan_id is not null then array[c.plan_id]
          else '{}'::text[]
        end
        where (c.plan_ids is null or c.plan_ids = '{}'::text[])
          and c.plan_id is not null
      `)

      await this.pool.query(`
        create table if not exists client_assignments (
          client_id text not null references clients(id) on delete cascade,
          user_id text not null references users(id) on delete cascade,
          assigned_at timestamptz not null default now(),
          primary key (client_id, user_id)
        )
      `)

      await this.pool.query(`
        create table if not exists time_entries (
          id text primary key,
          user_id text not null references users(id) on delete restrict,
          client_id text not null references clients(id) on delete restrict,
          entry_date date not null,
          -- numeric (not integer) so sub-minute precision survives: an
          -- exact-seconds timer stop is a fraction (0.75 = 45s). A fresh
          -- install must match the migrated production schema (see the
          -- integer→numeric migration further down).
          minutes numeric not null check (minutes > 0),
          category text not null,
          description text not null default '',
          billable boolean not null default true,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `)
      await this.pool.query(`alter table time_entries add column if not exists task_id text`)

      // Soft-delete column for the checklist recycle bin. Idempotent on every
      // boot. A null `deleted_at` means an active checklist; a non-null value
      // is the moment an owner sent it to the bin. Rows in the bin are
      // preserved (with their cascade-linked items) until the owner empties
      // the bin or restores them.
      await this.pool.query(`alter table checklists add column if not exists deleted_at timestamptz`)

      // Staff deletion-request workflow. A non-owner can REQUEST a checklist be
      // deleted; the row stays active (deleted_at null) but carries who asked
      // and when, until an owner approves (real soft-delete) or rejects (clears
      // these). Idempotent on every boot, mirrors the deleted_at column above.
      await this.pool.query(
        `alter table checklists add column if not exists deletion_requested_by text`,
      )
      await this.pool.query(
        `alter table checklists add column if not exists deletion_requested_at timestamptz`,
      )

      // Creator tracking for task-edit approval routing. A plain text user id
      // (no FK) set at POST /api/checklists; NULL on system-created instances
      // (recurring / template / onboarding) and on every pre-feature row. A
      // non-creator, non-owner editing a task's details/steps files a pending
      // edit routed to this user (see the pending_task_edits table below).
      await this.pool.query(`alter table checklists add column if not exists created_by text`)

      // Task-edit approval queue: a NON-creator (and non-owner) edited a task's
      // details / a step / added a step; nothing is applied until the approver
      // (the creator, else the owner) approves. Endpoint-managed (NOT part of
      // the bulk app-data write) — exactly like item_deletion_requests — so
      // staff can file without the owner-only bulk save. `proposed` is the
      // field→newValue patch to apply on approve; `summary` snapshots a readable
      // description for the queue. Plain text ids (no FK) so the row survives an
      // unrelated edit.
      await this.pool.query(`
        create table if not exists pending_task_edits (
          id text primary key,
          checklist_id text not null,
          item_id text,
          scope text not null,
          proposed jsonb not null default '{}'::jsonb,
          summary text,
          requested_by text,
          requested_by_name text,
          approver_id text,
          requested_at timestamptz not null default now()
        )
      `)
      await this.pool.query(
        `create index if not exists pending_task_edits_approver_idx on pending_task_edits (approver_id)`,
      )

      // ---- Quiet skip for recurring checklist tasks (lib/checklist-skip.js) ----
      //
      // Whether skipping is offered AT ALL is a property of the recurring
      // TEMPLATE, set when it is created, defaulting OFF. It lives only here and
      // never on the instance: copying it down would make a later change of mind
      // apply to some materialized rows and not others.
      await this.pool.query(
        `alter table checklist_templates add column if not exists skip_allowed boolean not null default false`,
      )
      // The period a recurring task's work COVERS — featreq-81429ad1. Opt-in
      // per template ("not all checklist/task would have it"), and the offset is
      // how many periods back the covered one sits: 1 because July's books are
      // done in August. The instance stores the resolved STRING, so the label a
      // task was born with never moves under it.
      await this.pool.query(
        `alter table checklist_templates add column if not exists period_label_enabled boolean not null default false`,
      )
      // The FIRST covered window, picked as dates — her rework of
      // featreq-81429ad1: "The period covers should allow me to pick dates and
      // then the how often should determine the next period". Every later cycle
      // is DERIVED from these three, never stored, so nothing can drift.
      // `period_label_offset` above is retired by this and left in place rather
      // than dropped: nothing reads it, and dropping a live column earns a
      // destructive migration for no gain.
      await this.pool.query(
        `alter table checklist_templates add column if not exists period_coverage_start date`,
      )
      await this.pool.query(
        `alter table checklist_templates add column if not exists period_coverage_end date`,
      )
      await this.pool.query(
        `alter table checklist_templates add column if not exists period_coverage_anchor_due date`,
      )
      await this.pool.query(`alter table checklists add column if not exists period_label text`)

      // The instance's own skip marker. Deliberately NOT a soft-delete: the row
      // must stay out of the recycle bin and stay visible to the materializer's
      // identity tuple (template_id, due_date, stage_index), because that is what
      // stops this period respawning while the NEXT period's different due date
      // generates exactly as before. Views drop skipped rows from the active
      // lists, so a skipped task can never reach an overdue bucket either.
      await this.pool.query(`alter table checklists add column if not exists skipped_at timestamptz`)
      await this.pool.query(`alter table checklists add column if not exists skipped_by text`)

      // The audit trail itself. Endpoint-managed (NOT part of the bulk
      // /api/app-data write) — exactly like pending_task_edits — so staff can
      // file a skip without the owner-only bulk save, and so a stale tab's
      // autosave can never clobber one. Plain text ids (no FK) and a `title`
      // snapshot so the record survives the task being renamed or deleted: it is
      // kept FOREVER, reviewing only stamps it.
      await this.pool.query(`
        create table if not exists checklist_skips (
          id text primary key,
          checklist_id text not null,
          template_id text,
          client_id text,
          title text not null,
          skipped_by text,
          skipped_by_name text,
          skipped_at timestamptz not null default now(),
          reason_category text not null,
          reason_note text not null,
          reviewed_by text,
          reviewed_at timestamptz
        )
      `)
      await this.pool.query(
        `create index if not exists checklist_skips_skipped_at_idx on checklist_skips (skipped_at desc)`,
      )

      // Time approval workflow. Detect whether the column already exists BEFORE
      // adding it: if this is the first deploy of the feature, every existing
      // entry is backfilled to 'approved' so there's no pending backlog. On
      // subsequent restarts the column exists and we skip the backfill.
      const approvalColumnExists = await this.pool.query(`
        select 1 from information_schema.columns
        where table_name = 'time_entries' and column_name = 'approval_status'
      `)
      await this.pool.query(
        `alter table time_entries add column if not exists approval_status text not null default 'pending'`,
      )
      await this.pool.query(`alter table time_entries add column if not exists approval_note text`)
      await this.pool.query(`alter table time_entries add column if not exists approved_by text`)
      await this.pool.query(`alter table time_entries add column if not exists approved_at timestamptz`)
      if (approvalColumnExists.rowCount === 0) {
        await this.pool.query(`update time_entries set approval_status = 'approved'`)
        console.log('[migrate] backfilled existing time entries to approval_status = approved')
      }

      // Manual time entry: timer-stopped entries are 'timer'; the gated manual
      // entry form sets 'manual' with a required reason. The not-null default
      // backfills every existing row to 'timer'.
      await this.pool.query(
        `alter table time_entries add column if not exists entry_method text not null default 'timer'`,
      )
      await this.pool.query(`alter table time_entries add column if not exists manual_reason text`)

      // Administrative / internal time (company meetings, training, etc.) is
      // not tied to any client, so client_id must be nullable and we flag the
      // row as administrative. Additive + idempotent.
      await this.pool.query(
        `alter table time_entries add column if not exists is_administrative boolean not null default false`,
      )
      await this.pool.query(`alter table time_entries alter column client_id drop not null`)

      // Ad hoc time: a one-off request outside the client's scoped work. Flagged
      // by whoever logs it (any employee, at entry) and correctable by an owner
      // at review. It bills as its OWN invoice line at that employee's rate
      // rather than inside "Billable hours — <name>", so the flag is what
      // decides which of the two paths the time is billed through — never both.
      // Additive + idempotent; every existing row is scoped work.
      await this.pool.query(
        `alter table time_entries add column if not exists is_adhoc boolean not null default false`,
      )

      // Audit timestamps: the exact start/stop of the work. Populated for new
      // timer entries (from the timer span) and manual entries (entered by the
      // user). Nullable — legacy rows predate this and simply have no span.
      await this.pool.query(`alter table time_entries add column if not exists started_at timestamptz`)
      await this.pool.query(`alter table time_entries add column if not exists ended_at timestamptz`)

      // Work sessions: the list of exact start/stop spans that make up an
      // entry (timer + "Resume" + "Add time" each append one). `minutes` is the
      // sum; started_at/ended_at remain the first-start/last-stop envelope.
      await this.pool.query(
        `alter table time_entries add column if not exists sessions jsonb not null default '[]'::jsonb`,
      )

      // Group time: a single block of work the owner allocated across multiple
      // clients. Each client gets its own entry, all sharing this group id so
      // the batch can be recognized (and managed) together. Additive + nullable.
      await this.pool.query(`alter table time_entries add column if not exists group_id text`)
      // Member client ids on an UNSPLIT group holding entry (the tracked block
      // waiting to be split). Empty on ordinary + already-split entries.
      await this.pool.query(
        `alter table time_entries add column if not exists group_client_ids text[] not null default '{}'`,
      )
      // Which allocation mode produced a SLICE of a split group block ('even' /
      // 'full' / 'custom'). Null on every other entry. Payroll needs it because
      // a 'full'-mode group deliberately bills each client the whole block, so
      // its wall time must be counted ONCE rather than once per slice.
      await this.pool.query(`alter table time_entries add column if not exists group_allocation text`)
      // Free-text task name, used when the client has no active checklist task.
      await this.pool.query(`alter table time_entries add column if not exists task_label text`)
      // Sub-minute precision: store minutes as numeric (fractional, e.g. 0.75 =
      // 45s) so an exact-seconds timer stop isn't rounded away. Guarded so the
      // table rewrite happens only once (while the column is still integer).
      await this.pool.query(`
        do $$
        begin
          if (
            select data_type from information_schema.columns
            where table_name = 'time_entries' and column_name = 'minutes'
          ) = 'integer' then
            alter table time_entries alter column minutes type numeric using minutes::numeric;
          end if;
        end $$;
      `)

      // Month-end timesheet locks: one per employee per 'YYYY-MM' period.
      await this.pool.query(`
        create table if not exists timesheet_locks (
          id text primary key,
          user_id text not null,
          period text not null,
          locked_by text not null,
          locked_at timestamptz not null default now(),
          unique (user_id, period)
        )
      `)

      // Per-client expense reimbursements. Each row is an out-of-pocket
      // expense the firm fronts and bills back on the client's invoice
      // for the month matching `date`. Owner-managed; the client_id FK
      // cascades on client delete so we don't leak orphan rows.
      await this.pool.query(`
        create table if not exists reimbursements (
          id text primary key,
          client_id text not null references clients(id) on delete cascade,
          date date not null,
          description text not null,
          amount numeric(12, 2) not null,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `)
      await this.pool.query(`
        create index if not exists reimbursements_client_date_idx
          on reimbursements(client_id, date)
      `)

      // Recurring per-client reimbursements (monthly / quarterly / annual).
      // No row is generated per billing period — `getInvoice` decides whether
      // to synthesize a line at read time based on `start_date` + `frequency`.
      // Same on-delete-cascade for client_id as the one-off table.
      await this.pool.query(`
        create table if not exists recurring_reimbursements (
          id text primary key,
          client_id text not null references clients(id) on delete cascade,
          description text not null,
          amount numeric(12, 2) not null,
          frequency text not null check (frequency in ('monthly', 'quarterly', 'annually')),
          start_date date not null,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `)
      await this.pool.query(`
        create index if not exists recurring_reimbursements_client_idx
          on recurring_reimbursements(client_id)
      `)

      // Covered-date windows. An expense whose invoice wording has to name the
      // period it covers (the QBO subscription, 13th to 13th) carries the
      // wording ONCE, with placeholders, plus the first window typed by hand;
      // generation walks the window forward from there.
      //
      // `coverage_history` is the ledger: billing period -> the window that
      // period was billed for. It is what makes the advance idempotent — void
      // and regenerate a month and the stored answer is handed straight back,
      // rather than the window stepping again. See lib/expense-coverage.js.
      //
      // All added rather than baked into the create above, because the table
      // predates this and production already has rows in it.
      await this.pool.query(
        `alter table recurring_reimbursements add column if not exists coverage_enabled boolean not null default false`,
      )
      await this.pool.query(
        `alter table recurring_reimbursements add column if not exists coverage_template text`,
      )
      await this.pool.query(
        `alter table recurring_reimbursements add column if not exists coverage_start date`,
      )
      await this.pool.query(
        `alter table recurring_reimbursements add column if not exists coverage_end date`,
      )
      // The day of the month the cycle turns on. STORED rather than re-derived
      // from `coverage_start`/`coverage_end`, because a window the owner
      // CONFIRMED onto a different day would otherwise snap back on the next
      // advance — moving an end from the 13th to the 20th and having the cycle
      // after it propose the 13th again bills a 23-day period at full price.
      await this.pool.query(
        `alter table recurring_reimbursements add column if not exists coverage_anchor_day int`,
      )
      // Backfill for rows that predate the column: the seed window's end day is
      // exactly what the resolver used to derive, so this is a no-op in
      // behavior and simply makes the value explicit from here on.
      await this.pool.query(
        `update recurring_reimbursements
            set coverage_anchor_day = extract(day from coverage_end)::int
          where coverage_anchor_day is null and coverage_end is not null`,
      )
      await this.pool.query(
        `alter table recurring_reimbursements add column if not exists coverage_paused boolean not null default false`,
      )
      await this.pool.query(
        `alter table recurring_reimbursements add column if not exists coverage_resume_pending boolean not null default false`,
      )
      await this.pool.query(
        `alter table recurring_reimbursements add column if not exists coverage_history jsonb not null default '{}'::jsonb`,
      )

      // Weekly lock-for-review submissions: a bookkeeper / accountant
      // submits their Sun-Sat week and an owner approves or rejects it.
      // Exactly one row per (user, week) — a resubmit after rejection
      // upgrades the same row back to 'pending'. The owner approval path
      // also flips every pending time entry in that week to 'approved'
      // (the per-entry approval_status workflow predates this and stays
      // intact for granular owner edits).
      await this.pool.query(`
        create table if not exists weekly_submissions (
          id text primary key,
          user_id text not null references users(id) on delete cascade,
          week_start date not null,
          submitted_at timestamptz not null default now(),
          status text not null,
          reviewed_by text,
          reviewed_at timestamptz,
          review_note text,
          unique (user_id, week_start)
        )
      `)

      await this.pool.query(`
        create table if not exists checklists (
          id text primary key,
          title text not null,
          client_id text not null references clients(id) on delete cascade,
          assignee_id text not null references users(id) on delete restrict,
          template_id text,
          frequency text,
          due_date date not null,
          viewer_ids text[] not null default '{}',
          editor_ids text[] not null default '{}',
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `)

      await this.pool.query(`
        alter table checklists
          add column if not exists viewer_ids text[] not null default '{}'
      `)

      await this.pool.query(`
        alter table checklists
          add column if not exists editor_ids text[] not null default '{}'
      `)

      await this.pool.query(`
        create table if not exists checklist_items (
          id text primary key,
          checklist_id text not null references checklists(id) on delete cascade,
          label text not null,
          done boolean not null default false,
          sort_order integer not null default 0,
          due_date date,
          assignee_id text,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `)

      await this.pool.query(`alter table checklist_items add column if not exists due_date date`)
      await this.pool.query(`alter table checklist_items add column if not exists assignee_id text`)
      // Recurring day-of-month on a LIVE checklist item (1–31), mirroring the
      // template + sub-item support. Without this column the "Day of month" due
      // option on a live checklist line was silently dropped on save.
      await this.pool.query(
        `alter table checklist_items add column if not exists due_day_of_month int`,
      )
      // Free-text "waiting on" note: why an unfinished item is blocked.
      await this.pool.query(
        `alter table checklist_items add column if not exists waiting_on text`,
      )
      // "Waiting on" flag (the toggle): when true the item is blocked/delayed
      // and surfaces on the owner's Delayed page. Additive + defaulted.
      await this.pool.query(
        `alter table checklist_items add column if not exists waiting boolean not null default false`,
      )
      // The checklist (task) this item is waiting on — when that one is
      // completed, this item's assignee is notified. Additive + nullable.
      await this.pool.query(
        `alter table checklist_items add column if not exists waiting_for_checklist_id text`,
      )
      // Structured "waiting on a person" blockers: a JSONB array of
      // { id, blockerId, requestedBy, note?, createdAt } on each item. Additive
      // + defaulted; sub-items / sub-sub-items carry the same field inside the
      // existing sub_items JSONB. See the WaitingOn type in src/lib/types.ts.
      await this.pool.query(
        `alter table checklist_items add column if not exists waiting_ons jsonb not null default '[]'::jsonb`,
      )
      // Sub-bullets: one level of nested sub-items, stored as a JSONB array
      // ({ id, title, done }[]) directly on the item row. Least-invasive
      // choice given the existing schema; mirrors the `payload jsonb` pattern.
      await this.pool.query(
        `alter table checklist_items add column if not exists sub_items jsonb not null default '[]'::jsonb`,
      )
      // WHEN a step was completed. `done` is a bare boolean and always was, so
      // until this column existed nothing in the product recorded the moment
      // anything finished — the "audit trail" the Completed tasks tab shows is
      // built from this. Nullable on purpose and NOT backfilled: every row that
      // predates it was completed at an unknown time, and inventing one (the
      // migration's own clock, `updated_at`, the due date) would put a wrong
      // date in front of someone auditing the work. Those rows render an
      // explicit placeholder instead. See `preservedItemCompletion`.
      await this.pool.query(
        `alter table checklist_items add column if not exists completed_at timestamptz`,
      )

      await this.pool.query(`
        create table if not exists checklist_templates (
          id text primary key,
          title text not null,
          client_id text not null references clients(id) on delete cascade,
          assignee_id text not null references users(id) on delete restrict,
          frequency text not null check (frequency in ('daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'annually')),
          next_due_date date not null,
          active boolean not null default true,
          viewer_ids text[] not null default '{}',
          editor_ids text[] not null default '{}',
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `)

      await this.pool.query(`
        alter table checklist_templates
          add column if not exists viewer_ids text[] not null default '{}'
      `)

      await this.pool.query(`
        alter table checklist_templates
          add column if not exists editor_ids text[] not null default '{}'
      `)

      // Wave 2: standard (client-agnostic) templates. is_standard rows are
      // reusable blueprints with no client; client_id is relaxed to nullable
      // so standard rows can omit it. Non-standard templates still require a
      // client (enforced in the API layer).
      await this.pool.query(`
        alter table checklist_templates
          add column if not exists is_standard boolean not null default false
      `)
      await this.pool.query(`
        alter table checklist_templates alter column client_id drop not null
      `)

      // Specific-months scheduling: a template can target designated months
      // instead of a fixed recurring cadence. The `frequency` CHECK constraint
      // predates the 'specific-months' value, so drop it and re-add it widened.
      await this.pool.query(`
        alter table checklist_templates
          add column if not exists scheduled_months int[]
      `)
      await this.pool.query(`
        alter table checklist_templates
          add column if not exists due_day_of_month int
      `)
      // Per-month due-day map for specific-months templates (month -> day),
      // superseding the single shared due_day_of_month. Additive + nullable so
      // existing templates keep their behavior until edited.
      await this.pool.query(`
        alter table checklist_templates
          add column if not exists monthly_due_days jsonb
      `)
      // A specific-months template has no fixed next-due date, so next_due_date
      // must be nullable.
      await this.pool.query(`
        alter table checklist_templates alter column next_due_date drop not null
      `)
      await this.pool.query(`
        alter table checklist_templates
          drop constraint if exists checklist_templates_frequency_check
      `)
      await this.pool.query(`
        alter table checklist_templates
          add constraint checklist_templates_frequency_check
          check (frequency in ('daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'annually', 'specific-months'))
      `)

      // "Repeat every year" toggle for specific-months templates. Defaults to
      // true so every existing template keeps repeating annually. schedule_year
      // pins the calendar year when repeat_annually is off.
      await this.pool.query(`
        alter table checklist_templates
          add column if not exists repeat_annually boolean not null default true
      `)
      await this.pool.query(`
        alter table checklist_templates
          add column if not exists schedule_year int
      `)

      // Lead time: how many days before its due date a recurring instance
      // appears. Default 0 = legacy (appears on the due date).
      await this.pool.query(`
        alter table checklist_templates
          add column if not exists lead_days int not null default 0
      `)

      await this.pool.query(`
        create table if not exists checklist_template_items (
          id text primary key,
          template_id text not null references checklist_templates(id) on delete cascade,
          label text not null,
          sort_order integer not null default 0,
          due_date date,
          assignee_id text,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `)

      await this.pool.query(`alter table checklist_template_items add column if not exists due_date date`)
      await this.pool.query(`alter table checklist_template_items add column if not exists assignee_id text`)
      await this.pool.query(`alter table checklist_template_items add column if not exists stage_id text`)
      // Sub-bullets on template items, stored as a JSONB array ({ id, title }[])
      // so sub-steps defined in a template flow into generated checklists.
      await this.pool.query(
        `alter table checklist_template_items add column if not exists sub_items jsonb not null default '[]'::jsonb`,
      )
      // Per-node recurring day-of-month due spec (1–31), resolved per cycle
      // month at materialization. Additive + nullable so existing template
      // items keep their behavior.
      await this.pool.query(
        `alter table checklist_template_items add column if not exists due_day_of_month int`,
      )

      // Phase 3: workflow stages on templates.
      await this.pool.query(`
        create table if not exists checklist_template_stages (
          id text primary key,
          template_id text not null references checklist_templates(id) on delete cascade,
          name text not null,
          assignee_id text,
          offset_days int not null default 0,
          position int not null default 0,
          viewer_ids text[] not null default '{}',
          editor_ids text[] not null default '{}',
          updated_at timestamptz not null default now()
        )
      `)
      await this.pool.query(`
        create index if not exists checklist_template_stages_template_idx on checklist_template_stages(template_id)
      `)
      // Wave 2: per-stage explicit due date (overrides offset_days when set).
      await this.pool.query(`alter table checklist_template_stages add column if not exists due_date date`)
      // Per-stage recurring day-of-month due spec (1–31), resolved per cycle
      // month. Additive + nullable so existing stages keep their behavior.
      await this.pool.query(
        `alter table checklist_template_stages add column if not exists due_day_of_month int`,
      )
      await this.pool.query(`alter table checklists add column if not exists case_id text`)
      await this.pool.query(`alter table checklists add column if not exists stage_id text`)
      await this.pool.query(`alter table checklists add column if not exists stage_index int`)
      await this.pool.query(`alter table checklists add column if not exists stage_count int`)
      // Onboarding case link — the client whose lifecycle this stage drives.
      // Set only on the stages of an onboarding case; null everywhere else.
      await this.pool.query(
        `alter table checklists add column if not exists onboarding_for_client_id text`,
      )
      await this.pool.query(
        `alter table checklist_templates add column if not exists onboarding_for_client_id text`,
      )

      // The invoice of record (I1). The app — not Stripe, not QBO — owns the
      // numbering, the lines and the history; see
      // docs/plans/invoicing-in-app-2026-08.md.
      //
      // `client_id` is `on delete restrict`, which means the bulk save CANNOT
      // `delete from clients` while any invoice exists. That table therefore has
      // to be snapshotted and restored around the bulk save exactly like the
      // `invoice_drafts` table it replaces — see the preserve/restore pair in
      // `write()`. Getting that wrong does not fail loudly; it wedges every
      // owner save.
      await this.pool.query(`
        create table if not exists invoices (
          id text primary key,
          client_id text not null references clients(id) on delete restrict,
          period text not null,
          number text,
          status text not null default 'draft',
          line_items jsonb not null default '[]'::jsonb,
          subtotal numeric(12, 2) not null default 0,
          total numeric(12, 2) not null default 0,
          due_date text,
          blurb text not null default '',
          scope_flags jsonb not null default '[]'::jsonb,
          sent_at timestamptz,
          paid_at timestamptz,
          stripe_checkout_session_id text,
          stripe_card_session_id text,
          stripe_payment_intent_id text,
          payment_method text,
          email_log jsonb not null default '[]'::jsonb,
          original_line_items jsonb,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now()
        )
      `)
      // The table above already exists in production, so the card column needs
      // its own additive migration — `create table if not exists` is a no-op
      // there and would leave every deployed row without it.
      await this.pool.query(
        `alter table invoices add column if not exists stripe_card_session_id text`,
      )
      // What KIND of document this is: 'monthly' (the month run's output) or
      // 'retainer' (issued once when a client signs the engagement letter).
      // Additive with a default, so every existing production row becomes what
      // it already was.
      await this.pool.query(
        `alter table invoices add column if not exists kind text not null default 'monthly'`,
      )
      // On a RETAINER row: the invoice its credit was given back on. Null means
      // the money is still held on account. This column is the never-twice rule
      // — see `updateInvoice`, which only ever sets it from null.
      await this.pool.query(
        `alter table invoices add column if not exists applied_to_invoice_id text`,
      )
      // The generated lines, snapshotted once at insert. NULLABLE with no
      // default on purpose: every row that already exists in production was
      // generated before this existed, and there is no honest value to invent
      // for it — `null` is "unknown", and the diff simply has no before-side.
      // Nothing but `_insertInvoice` ever writes it; `updateInvoice` must not.
      await this.pool.query(
        `alter table invoices add column if not exists original_line_items jsonb`,
      )
      // PARTIAL unique — one live invoice per client per month, but a VOIDED
      // one must not block re-generating. Same lesson as the checklist
      // materializer's instance index, applied from day one rather than after
      // duplicates appeared.
      //
      // Now scoped to MONTHLY invoices as well. A retainer is issued alongside
      // whatever month it lands in, so the old (client_id, period) rule would
      // have refused it — silently, since `_insertInvoice` reads a refusal as
      // "someone else got there first". The old index is dropped BY NAME first:
      // `create ... if not exists` under a new name would otherwise leave the
      // strict one in place and the new one would never get a chance to matter.
      //
      // THE SWAP IS ONE TRANSACTION. Between the drop and the create there is no
      // index enforcing one live invoice per client per month, and this table is
      // the invoice of record — a generate landing in that gap could write a
      // client two live invoices for the same month, which nothing downstream
      // would ever notice. `create index` (non-concurrent) is transactional in
      // Postgres, so the gap can simply be closed.
      //
      // EXPECTED DURING THE DEPLOY MINUTE: the OLD container is still serving
      // and its `_insertInvoice` names the old predicate, which now matches no
      // index — that inference fails with 42P10 ("no unique or exclusion
      // constraint matching the ON CONFLICT specification"). It surfaces as a
      // 500 on Generate for the seconds before the old container goes away, and
      // is benign on a single replica: nothing is written, and a retry against
      // the new container succeeds.
      const indexClient = await this.pool.connect()
      try {
        await indexClient.query('BEGIN')
        await indexClient.query(`drop index if exists invoices_client_period_live`)
        await indexClient.query(`
          create unique index if not exists invoices_client_period_monthly_live
            on invoices (client_id, period)
            where kind = 'monthly' and status <> 'void'
        `)
        await indexClient.query('COMMIT')
      } catch (error) {
        try {
          await indexClient.query('ROLLBACK')
        } catch {
          /* already rolled back, or the connection is gone */
        }
        throw error
      } finally {
        indexClient.release()
      }
      await this.pool.query(`
        create unique index if not exists invoices_number_unique
          on invoices (number)
          where number is not null
      `)
      // Webhook dedup ledger. Stripe retries until it gets a 2xx and can
      // deliver out of order, so the same event id legitimately arrives more
      // than once; the primary key is what makes re-delivery a no-op.
      await this.pool.query(`
        create table if not exists stripe_events (
          id text primary key,
          type text not null default '',
          received_at timestamptz not null default now()
        )
      `)
      // Stripe customer per client, filled in at first send (I3).
      await this.pool.query(
        `alter table clients add column if not exists stripe_customer_id text`,
      )
      // `invoice_drafts` was the placeholder for this and was never written to
      // (0 rows in production, confirmed before dropping). `invoices`
      // supersedes it; keeping both would mean two tables carrying the same
      // bulk-save hazard, one of them dead.
      await this.pool.query(`drop table if exists invoice_drafts`)

      // ---- The invoice-confidence pair (docs/plans/invoice-confidence-2026-08.md) ----
      //
      // NEITHER of these carries a foreign key to `invoices`, and that is
      // deliberate rather than sloppy. The bulk save DELETES every invoice row
      // and puts it back (see `write()`); a restricting child FK would refuse
      // that delete and wedge every owner autosave, and a cascading one would
      // silently take the audit trail with it. Plain text `invoice_id`, exactly
      // like `client_notes` / `item_deletion_requests`.
      //
      // Both are also endpoint-managed: they are NOT in the bulk-save payload
      // and NOT in the staleness fingerprint, so an autosave can neither write
      // nor destroy them.

      // What a HUMAN did to an invoice. Append-only; one row per save that
      // actually changed something. This is the audit surface for the ratings
      // feature — `activity_log` deliberately is not (it is trimmed to 200 rows
      // per user, and invoice edits would evict real activity).
      await this.pool.query(`
        create table if not exists invoice_review_events (
          id text primary key,
          invoice_id text not null,
          client_id text,
          period text,
          actor_user_id text,
          event text not null default 'edited',
          changes jsonb not null default '{}'::jsonb,
          created_at timestamptz not null default now()
        )
      `)
      await this.pool.query(
        `create index if not exists invoice_review_events_invoice_idx
           on invoice_review_events (invoice_id)`,
      )

      // What the MODEL said about a draft. History is kept rather than
      // overwritten — a re-rate marks the prior rows `superseded` — because the
      // whole point of the feature is the record of confidence-vs-corrections
      // over months, and an overwriting table would have no record at all.
      await this.pool.query(`
        create table if not exists invoice_ai_reviews (
          id text primary key,
          invoice_id text not null,
          client_id text,
          period text,
          model text,
          confidence text not null default 'medium',
          score integer not null default 0,
          summary text not null default '',
          concerns jsonb not null default '[]'::jsonb,
          questions jsonb not null default '[]'::jsonb,
          lines_fingerprint text,
          superseded boolean not null default false,
          created_at timestamptz not null default now()
        )
      `)
      await this.pool.query(
        `create index if not exists invoice_ai_reviews_invoice_idx
           on invoice_ai_reviews (invoice_id)`,
      )

      await this.cleanupSeedEmployeesInPostgres()
      await this.seedUsersInPostgres()
      await this.seedRelationalDataInPostgres()
      await this.syncOwnerEmailInPostgres()
      await this.backfillContactsFromClientsInPostgres()
      return
    }

    await mkdir(path.dirname(localDataPath), { recursive: true })
    if (!existsSync(localDataPath)) {
      const seed = await this.getSeedData()
      await writeFile(localDataPath, JSON.stringify(seed, null, 2))
    }

    if (!existsSync(localAuthPath)) {
      await writeFile(
        localAuthPath,
        JSON.stringify(
          {
            users: createSeededAuthUsers(),
            sessions: [],
            activityLog: [],
            notifications: [],
            loginTokens: [],
            userSessions: [],
            pendingTwoFactor: [],
          },
          null,
          2,
        ),
      )
    } else {
      // Backfill missing fields on existing local auth state for legacy installs.
      const authState = await readJson(localAuthPath)
      let mutated = false
      const createdAt = nowIso()
      authState.users = (authState.users ?? []).map((user) => {
        let next = user
        if (!user.magicToken) {
          next = { ...next, magicToken: generateMagicToken() }
          mutated = true
        }
        if (next.tokenRevokedAt === undefined) {
          next = { ...next, tokenRevokedAt: null }
          mutated = true
        }
        if (next.lastActiveAt === undefined) {
          next = { ...next, lastActiveAt: null }
          mutated = true
        }
        if (!next.createdAt) {
          next = { ...next, createdAt }
          mutated = true
        }
        if (!next.email) {
          next = { ...next, email: `${next.id}@pbj.local` }
          mutated = true
        }
        // TOTP fields backfill (idempotent).
        if (next.totpSecret === undefined) {
          next = { ...next, totpSecret: null }
          mutated = true
        }
        if (next.totpEnabled === undefined) {
          next = { ...next, totpEnabled: false }
          mutated = true
        }
        if (!Array.isArray(next.totpBackupCodes)) {
          next = { ...next, totpBackupCodes: [] }
          mutated = true
        }
        if (next.pendingTotpSecret === undefined) {
          next = { ...next, pendingTotpSecret: null }
          mutated = true
        }
        return next
      })
      if (!Array.isArray(authState.activityLog)) {
        authState.activityLog = []
        mutated = true
      }
      if (!Array.isArray(authState.notifications)) {
        authState.notifications = []
        mutated = true
      }
      if (!Array.isArray(authState.loginTokens)) {
        authState.loginTokens = []
        mutated = true
      }
      if (!Array.isArray(authState.userSessions)) {
        authState.userSessions = []
        mutated = true
      }
      if (!Array.isArray(authState.pendingTwoFactor)) {
        authState.pendingTwoFactor = []
        mutated = true
      }
      if (mutated) {
        await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
      }
    }
    await this.syncOwnerEmailInFile()
  }

  async syncOwnerEmailInPostgres() {
    const ownerEmail = process.env.OWNER_EMAIL?.trim().toLowerCase()
    if (!ownerEmail) {
      const cur = await this.pool.query(`select email from users where id = 'emp-patrice'`)
      const currentEmail = cur.rows[0]?.email ?? '(none)'
      console.log(`[auth] OWNER_EMAIL not set; existing owner email left as ${currentEmail}`)
    } else {
      const result = await this.pool.query(
        `update users set name = 'Brittany Ferguson', email = $1, updated_at = now()
         where id = 'emp-patrice' and lower(coalesce(email, '')) != $1
         returning id`,
        [ownerEmail],
      )
      if (result.rowCount > 0) {
        console.log(`[auth] Owner Brittany Ferguson email synced to ${ownerEmail}`)
      }
    }

    const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase()
    if (!adminEmail) {
      console.log('[auth] ADMIN_EMAIL not set; admin owner not created')
    } else {
      await this.pool.query(
        `insert into users (id, name, email, role, staff_role, password_hash)
         values ('emp-alex-anderson', 'Alex Anderson', $1, 'owner', 'Owner', $2)
         on conflict (id) do update
           set name = 'Alex Anderson',
               email = excluded.email,
               role = 'owner',
               staff_role = 'Owner',
               updated_at = now()`,
        [adminEmail, hashPassword(randomUUID())],
      )
      await this.pool.query(
        `update users set name = 'Alex Anderson', email = $1, role = 'owner', staff_role = 'Owner', updated_at = now()
         where lower(coalesce(email, '')) = $1 and id != 'emp-alex-anderson'`,
        [adminEmail],
      )
      console.log(`[auth] Admin Alex Anderson seeded/updated with email ${adminEmail}`)
    }
  }

  /**
   * One-time, idempotent boot migration: derive a reusable Contact from each
   * client's legacy free-text contact fields and link it via contact_ids.
   *
   * Idempotency: ONLY clients whose contact_ids is empty/`{}` are touched, and
   * the very last step of processing a client sets its contact_ids — so once a
   * client is linked it is permanently skipped on every future boot. Contacts
   * are deduped by EXACT case-insensitive (lower(trim(name)), lower(email)) so
   * two clients sharing the same contact reuse one row rather than duplicating.
   * Runs AFTER the contacts table + client contact_ids column migrations.
   */
  async backfillContactsFromClientsInPostgres() {
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      // Eligible clients: no linked contacts yet AND some legacy contact info.
      const { rows: eligible } = await client.query(`
        select id, contact, contact_name, email, phone
        from clients
        where (contact_ids is null or contact_ids = '{}'::text[])
          and (
            coalesce(nullif(trim(contact), ''), '') != ''
            or coalesce(nullif(trim(contact_name), ''), '') != ''
            or coalesce(nullif(trim(email), ''), '') != ''
            or coalesce(nullif(trim(phone), ''), '') != ''
          )
        for update
      `)

      let linked = 0
      for (const row of eligible) {
        const name = (row.contact && row.contact.trim()) || (row.contact_name && row.contact_name.trim()) || ''
        if (!name) continue // a contact with no name is useless — skip.
        const email = row.email && row.email.trim() ? row.email.trim() : null
        const phone = row.phone && row.phone.trim() ? row.phone.trim() : null

        // Find an existing contact matching EXACT case-insensitive name+email.
        const { rows: match } = await client.query(
          `select id from contacts
           where lower(trim(name)) = lower(trim($1))
             and lower(coalesce(email, '')) = lower(coalesce($2, ''))
           limit 1`,
          [name, email],
        )

        let contactId
        if (match.length > 0) {
          contactId = match[0].id
        } else {
          contactId = `contact-${randomUUID().slice(0, 8)}`
          await client.query(
            `insert into contacts (id, name, email, phone, updated_at)
             values ($1, $2, $3, $4, now())`,
            [contactId, name, email, phone],
          )
        }

        await client.query(`update clients set contact_ids = array[$1::text], updated_at = now() where id = $2`, [
          contactId,
          row.id,
        ])
        linked += 1
      }

      await client.query('commit')
      if (linked > 0) {
        console.log(`[migrate] Backfilled contacts for ${linked} client(s) from legacy contact fields`)
      }
    } catch (err) {
      await client.query('rollback')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * File-fallback mirror of `backfillContactsFromClientsInPostgres`. Same
   * idempotency rule: only clients with an empty `contactIds` are processed,
   * deduping against existing contacts by case-insensitive name+email. Mutates
   * `data` in place and returns whether anything changed.
   */
  backfillContactsFromClientsInFile(data) {
    const clients = Array.isArray(data.clients) ? data.clients : []
    const contacts = Array.isArray(data.contacts) ? data.contacts : []
    if (clients.length === 0) return false

    const keyOf = (name, email) =>
      `${String(name).trim().toLowerCase()}|${String(email ?? '').trim().toLowerCase()}`
    const byKey = new Map(contacts.map((c) => [keyOf(c.name, c.email), c]))

    let changed = false
    for (const client of clients) {
      const hasContacts = Array.isArray(client.contactIds) && client.contactIds.length > 0
      if (hasContacts) continue
      const name =
        (client.contact && String(client.contact).trim()) ||
        (client.contactName && String(client.contactName).trim()) ||
        ''
      const email = client.email && String(client.email).trim() ? String(client.email).trim() : ''
      const phone = client.phone && String(client.phone).trim() ? String(client.phone).trim() : ''
      // No legacy info at all → nothing to derive.
      if (!name && !email && !phone) continue
      // A contact with no name is useless — skip.
      if (!name) continue

      const key = keyOf(name, email)
      let contact = byKey.get(key)
      if (!contact) {
        contact = {
          id: `contact-${randomUUID().slice(0, 8)}`,
          name,
          email: email || undefined,
          phone: phone || undefined,
        }
        contacts.push(contact)
        byKey.set(key, contact)
      }
      client.contactIds = [contact.id]
      changed = true
    }

    if (changed) {
      data.contacts = contacts
    }
    return changed
  }

  async syncOwnerEmailInFile() {
    const authState = await readJson(localAuthPath)
    let mutated = false

    const ownerEmail = process.env.OWNER_EMAIL?.trim().toLowerCase()
    if (!ownerEmail) {
      const currentEmail = authState.users.find((u) => u.id === 'emp-patrice')?.email ?? '(none)'
      console.log(`[auth] OWNER_EMAIL not set; existing owner email left as ${currentEmail}`)
    } else {
      authState.users = authState.users.map((user) => {
        if (user.id === 'emp-patrice' && (user.email ?? '').toLowerCase() !== ownerEmail) {
          mutated = true
          return { ...user, name: 'Brittany Ferguson', email: ownerEmail }
        }
        return user
      })
      if (mutated) {
        console.log(`[auth] Owner Brittany Ferguson email synced to ${ownerEmail}`)
      }
    }

    const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase()
    if (!adminEmail) {
      console.log('[auth] ADMIN_EMAIL not set; admin owner not created')
    } else {
      const existingAdmin = authState.users.find((u) => u.id === 'emp-alex-anderson')
      if (!existingAdmin) {
        const createdAt = nowIso()
        authState.users.push({
          id: 'emp-alex-anderson',
          name: 'Alex Anderson',
          email: adminEmail,
          staffRole: 'Owner',
          role: 'owner',
          passwordHash: hashPassword(randomUUID()),
          magicToken: generateMagicToken(),
          tokenRevokedAt: null,
          lastActiveAt: null,
          createdAt,
        })
        mutated = true
      } else if (
        existingAdmin.name !== 'Alex Anderson' ||
        (existingAdmin.email ?? '').toLowerCase() !== adminEmail
      ) {
        authState.users = authState.users.map((u) =>
          u.id === 'emp-alex-anderson' ? { ...u, name: 'Alex Anderson', email: adminEmail } : u,
        )
        mutated = true
      }
      console.log(`[auth] Admin Alex Anderson seeded/updated with email ${adminEmail}`)
    }

    if (mutated) {
      await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    }
  }

  /**
   * One-time, idempotent cleanup of the leftover demo employees "Avery
   * Johnson" and "Jordan Ellis": move any work attributed to them onto the
   * firm owner (Brittany Ferguson) and delete the accounts so there's no trace
   * left in the app. Guarded by their existence (only acts while they're still
   * present) and fully wrapped so a failure can never block server boot. If a
   * hard delete is blocked, the account is deactivated as a safe fallback.
   */
  async cleanupSeedEmployeesInPostgres() {
    try {
      const ownerResult = await this.pool.query(
        `select id from users
         where id = 'emp-patrice' or lower(name) = 'brittany ferguson'
         order by (id = 'emp-patrice') desc, (role = 'owner') desc
         limit 1`,
      )
      const brittanyId = ownerResult.rows[0]?.id
      if (!brittanyId) return

      const fakesResult = await this.pool.query(
        `select id from users
         where id in ('emp-avery', 'emp-jordan')
            or lower(name) in ('avery johnson', 'jordan ellis')`,
      )
      for (const { id: fakeId } of fakesResult.rows) {
        if (fakeId === brittanyId) continue
        try {
          // Reassign everything that points at the fake user to Brittany. The
          // RESTRICT foreign keys (time_entries.user_id, checklists.assignee_id,
          // checklist_templates.assignee_id) MUST move before the delete; the
          // rest are reassigned for cleanliness.
          await this.pool.query(`update time_entries set user_id = $1 where user_id = $2`, [brittanyId, fakeId])
          await this.pool.query(`update time_entries set approved_by = $1 where approved_by = $2`, [brittanyId, fakeId])
          await this.pool.query(`update checklists set assignee_id = $1 where assignee_id = $2`, [brittanyId, fakeId])
          await this.pool.query(`update checklist_templates set assignee_id = $1 where assignee_id = $2`, [brittanyId, fakeId])
          await this.pool.query(`update checklist_items set assignee_id = $1 where assignee_id = $2`, [brittanyId, fakeId])
          await this.pool.query(`delete from users where id = $1`, [fakeId])
          console.log(`[cleanup] removed demo employee ${fakeId}; work reassigned to ${brittanyId}`)
        } catch (err) {
          console.error(`[cleanup] could not remove ${fakeId}; deactivating instead:`, err.message)
          try {
            await this.pool.query(`update users set inactive_at = now() where id = $1`, [fakeId])
          } catch {
            /* best effort — never block boot */
          }
        }
      }
    } catch (err) {
      console.error('[cleanup] seed-employee cleanup skipped:', err.message)
    }
  }

  async seedUsersInPostgres() {
    // Only seed the demo users into a BRAND-NEW workspace. On an established
    // one (any user already exists) we must never re-upsert them: doing it on
    // every boot resurrected deleted seed employees (e.g. Avery / Jordan) on
    // each deploy and overwrote real users' credentials with demo values.
    const existing = await this.pool.query('select count(*)::int as count from users')
    if (existing.rows[0].count > 0) {
      return
    }
    for (const user of createSeededAuthUsers()) {
      await this.pool.query(
        `
          insert into users (id, name, email, role, staff_role, password_hash, magic_token)
          values ($1, $2, $3, $4, $5, $6, $7)
          on conflict (id) do update
          set name = excluded.name,
              email = excluded.email,
              role = excluded.role,
              staff_role = excluded.staff_role,
              password_hash = excluded.password_hash,
              magic_token = coalesce(users.magic_token, excluded.magic_token),
              updated_at = now()
        `,
        [user.id, user.name, user.email, user.role, user.staffRole, user.passwordHash, user.magicToken],
      )
    }
  }

  async seedRelationalDataInPostgres() {
    const clientsResult = await this.pool.query('select count(*)::int as count from clients')
    if (clientsResult.rows[0].count > 0) {
      return
    }

    // PREVIOUSLY: we only checked the clients count, so any workspace
    // that had intentionally cleared its seed clients (active OR inactive
    // owner) got re-seeded on every server boot — every Railway redeploy
    // resurrected the demo clients, the orphan templates, and the orphan
    // checklists. The user-visible symptom: "I deleted everything and
    // came back later and it's all back." Now we also require zero users.
    // If any user row exists, the workspace was set up by a real person
    // at some point — never re-seed, even if the clients list is empty.
    const usersResult = await this.pool.query('select count(*)::int as count from users')
    if (usersResult.rows[0].count > 0) {
      return
    }

    const seed = await this.getSeedData()
    await this.write(seed)
  }

  async getSeedData() {
    return readJson(seedDataPath)
  }

  /**
   * How many clients currently exist. Cheap (a COUNT, never the full read()).
   * Used by the bulk-save guard to refuse a payload that would wipe a
   * populated workspace down to zero clients.
   */
  async clientCount() {
    if (this.pool) {
      const result = await this.pool.query('select count(*)::int as count from clients')
      return result.rows[0]?.count ?? 0
    }
    const data = await readJson(localDataPath)
    return Array.isArray(data.clients) ? data.clients.length : 0
  }

  /**
   * The raw Postgres workspace snapshot — every table `read()` serves, mapped
   * to the app shape, WITHOUT the materializer pass. Extracted from `read()`
   * so the guarded write-back can re-read a snapshot that is provably no older
   * than the fingerprint it writes under (see `read()`). The inner block is
   * the original `if (this.pool)` body, kept verbatim.
   */
  async _readPostgresWorkspace() {
    if (!this.pool) {
      throw new Error('_readPostgresWorkspace requires the Postgres pool')
    }
    {
      const [
        usersResult,
        plansResult,
        contactsResult,
        clientsResult,
        timeEntriesResult,
        checklistsResult,
        checklistItemsResult,
        checklistTemplatesResult,
        checklistTemplateItemsResult,
        checklistTemplateStagesResult,
        timesheetLocksResult,
        weeklySubmissionsResult,
        reimbursementsResult,
        recurringReimbursementsResult,
        inactiveUsersResult,
      ] =
        await Promise.all([
          // Active team only — soft-deleted users have inactive_at set and
          // appear in the separate `inactiveUsersResult` below so the UI
          // can offer "current team only" vs "include former" toggles
          // without conflating the two lists.
          this.pool.query(`
            select id, name, role, bill_rate
            from users
            where inactive_at is null
            order by sort_order asc nulls last, name asc
          `),
          this.pool.query(`
            select id, name, notes, template_ids
            from subscription_plans
            order by name asc
          `),
          this.pool.query(`
            select id, name, email, phone, title, notes, locked,
                   company_emails, linked_contact_ids, archived_at, group_name
            from contacts
            order by name asc
          `),
          this.pool.query(`
            select id, name, contact, billing_mode, hourly_rate, plan_id,
                   custom_monthly_fee, monthly_rate, estimated_monthly_hours,
                   estimated_bookkeeper_hours, estimated_accountant_hours,
                   estimated_cfo_hours,
                   plan_ids, contact_ids,
                   email, contact_name, phone, address_line1, address_line2,
                   city, state, postal_code, logo_url, payment_terms,
                   footer_note, quickbooks_pay_url, invoice_show_time_breakdown,
                   invoice_time_breakdown_mode, invoice_time_breakdown_amounts,
                   invoice_hide_internal_hours, invoice_group_by_category,
                   card_payments_enabled,
                   assigned_bookkeeper_ids, monthly_service_tier,
                   annual_rate, annual_billing_month, lifecycle_stage,
                   bill_to_client_id, is_billing_master, invoice_recipient_client_id
            from clients
            order by name asc
          `),
          this.pool.query(`
            select id, user_id, client_id, entry_date, minutes, category, description, billable, task_id,
                   approval_status, approval_note, approved_by, approved_at, entry_method, manual_reason,
                   is_administrative, is_adhoc, started_at, ended_at, sessions, group_id, group_client_ids,
                   group_allocation, task_label, created_at
            from time_entries
            order by entry_date desc, id desc
          `),
          this.pool.query(`
            select id, title, client_id, assignee_id, template_id, frequency, due_date, viewer_ids, editor_ids,
                   case_id, stage_id, stage_index, stage_count, category_id, deleted_at,
                   deletion_requested_by, deletion_requested_at, onboarding_for_client_id, created_by,
                   skipped_at, skipped_by, period_label
            from checklists
            order by due_date asc, id asc
          `),
          this.pool.query(`
            select ${CHECKLIST_ITEM_SELECT_COLUMNS}
            from checklist_items
            order by checklist_id asc, sort_order asc, id asc
          `),
          this.pool.query(`
            select id, title, client_id, assignee_id, frequency, next_due_date, active, viewer_ids, editor_ids, is_standard,
                   scheduled_months, due_day_of_month, monthly_due_days, repeat_annually, schedule_year, lead_days, category_id, source_template_id,
                   onboarding_for_client_id, skip_allowed, period_label_enabled,
                   period_coverage_start, period_coverage_end, period_coverage_anchor_due
            from checklist_templates
            order by title asc
          `),
          this.pool.query(`
            select id, template_id, label, sort_order, due_date, due_day_of_month, assignee_id, stage_id, sub_items
            from checklist_template_items
            order by template_id asc, sort_order asc, id asc
          `),
          this.pool.query(`
            select id, template_id, name, assignee_id, offset_days, due_date, due_day_of_month, position, viewer_ids, editor_ids
            from checklist_template_stages
            order by template_id asc, position asc, id asc
          `),
          this.pool.query(`
            select id, user_id, period, locked_by, locked_at
            from timesheet_locks
            order by period desc, user_id asc
          `),
          this.pool.query(`
            select id, user_id, week_start, submitted_at, status,
                   reviewed_by, reviewed_at, review_note
            from weekly_submissions
            order by week_start desc, user_id asc
          `),
          this.pool.query(`
            select id, client_id, date, description, amount
            from reimbursements
            order by date desc, id asc
          `),
          this.pool.query(`
            select id, client_id, description, amount, frequency, start_date,
                   coverage_enabled, coverage_template, coverage_start, coverage_end,
                   coverage_anchor_day, coverage_paused, coverage_resume_pending, coverage_history
            from recurring_reimbursements
            order by start_date desc, id asc
          `),
          // Soft-deleted (former) team members for the analytics "include
          // historical team" toggle. Same Employee shape as active users
          // but with an `inactiveAt` timestamp so the UI can label them.
          this.pool.query(`
            select id, name, role, inactive_at, bill_rate
            from users
            where inactive_at is not null
            order by inactive_at desc, name asc
          `),
        ])

      const itemsByChecklist = new Map()
      for (const row of checklistItemsResult.rows) {
        const existing = itemsByChecklist.get(row.checklist_id) ?? []
        existing.push(mapChecklistItemRow(row))
        itemsByChecklist.set(row.checklist_id, existing)
      }

      const templateItemsByTemplate = new Map()
      const templateItemsByStage = new Map()
      for (const row of checklistTemplateItemsResult.rows) {
        const item = {
          id: row.id,
          label: row.label,
        }
        if (row.due_date) {
          item.dueDate = row.due_date.toISOString().slice(0, 10)
        }
        if (typeof row.due_day_of_month === 'number') {
          item.dueDayOfMonth = row.due_day_of_month
        }
        if (row.assignee_id) {
          item.assigneeId = row.assignee_id
        }
        const subItems = normalizeSubItems(row.sub_items, { withDone: false })
        if (subItems.length > 0) {
          item.subItems = subItems
        }
        const allForTemplate = templateItemsByTemplate.get(row.template_id) ?? []
        allForTemplate.push(item)
        templateItemsByTemplate.set(row.template_id, allForTemplate)

        if (row.stage_id) {
          const list = templateItemsByStage.get(row.stage_id) ?? []
          list.push(item)
          templateItemsByStage.set(row.stage_id, list)
        }
      }

      const stagesByTemplate = new Map()
      for (const row of checklistTemplateStagesResult.rows) {
        const stage = {
          id: row.id,
          name: row.name,
          assigneeId: row.assignee_id ?? '',
          offsetDays: Number(row.offset_days) || 0,
          viewerIds: Array.isArray(row.viewer_ids) ? row.viewer_ids : [],
          editorIds: Array.isArray(row.editor_ids) ? row.editor_ids : [],
          items: templateItemsByStage.get(row.id) ?? [],
        }
        if (row.due_date) {
          stage.dueDate = row.due_date.toISOString().slice(0, 10)
        }
        if (typeof row.due_day_of_month === 'number') {
          stage.dueDayOfMonth = row.due_day_of_month
        }
        const list = stagesByTemplate.get(row.template_id) ?? []
        list.push(stage)
        stagesByTemplate.set(row.template_id, list)
      }

      // Map every checklist row once, then partition into active vs recycled
      // below. `deletedAt` is the only signal — a null timestamp means active.
      const allChecklists = checklistsResult.rows.map((row) => ({
        id: row.id,
        title: row.title,
        clientId: row.client_id,
        assigneeId: row.assignee_id,
        templateId: row.template_id,
        frequency: row.frequency,
        dueDate: row.due_date.toISOString().slice(0, 10),
        viewerIds: Array.isArray(row.viewer_ids) ? row.viewer_ids : [],
        editorIds: Array.isArray(row.editor_ids) ? row.editor_ids : [],
        caseId: row.case_id ?? row.id,
        stageId: row.stage_id ?? null,
        stageIndex: typeof row.stage_index === 'number' ? row.stage_index : 0,
        stageCount: typeof row.stage_count === 'number' ? row.stage_count : 1,
        categoryId: row.category_id ?? null,
        ...(row.onboarding_for_client_id
          ? { onboardingForClientId: row.onboarding_for_client_id }
          : {}),
        items: itemsByChecklist.get(row.id) ?? [],
        deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
        deletionRequestedBy: row.deletion_requested_by ?? null,
        deletionRequestedAt: row.deletion_requested_at
          ? row.deletion_requested_at.toISOString()
          : null,
        createdBy: row.created_by ?? null,
        // Quiet skip: a stamped instance stays in the ACTIVE list (it is not a
        // soft-delete) so the materializer's identity tuple still sees it; the
        // view layer is what drops it from the active surfaces.
        skippedAt: row.skipped_at ? row.skipped_at.toISOString() : null,
        skippedBy: row.skipped_by ?? null,
        // COSMETIC ONLY — see lib/checklist-period-label.js. Nothing may read
        // this to decide anything; it is rendered beside the title and that is
        // the whole of it.
        periodLabel: row.period_label ?? null,
      }))

      const data = {
        employees: usersResult.rows.map((row) => ({
          id: row.id,
          name: row.name,
          role: dbRoleToEmployeeRole(row.role),
          billRate: row.bill_rate == null ? null : Number(row.bill_rate),
        })),
        plans: plansResult.rows.map((row) => ({
          id: row.id,
          name: row.name,
          notes: row.notes,
          templateIds: Array.isArray(row.template_ids)
            ? row.template_ids.filter((id) => typeof id === 'string' && id)
            : [],
        })),
        contacts: contactsResult.rows.map((row) => ({
          id: row.id,
          name: row.name,
          email: row.email ?? '',
          phone: row.phone ?? '',
          title: row.title ?? '',
          notes: row.notes ?? '',
          ...(row.locked ? { locked: true } : {}),
          // jsonb: node-pg usually returns parsed objects, but tolerate a
          // string just in case. Keep only well-formed {clientId, email} pairs.
          companyEmails: parseCompanyEmails(row.company_emails),
          // text[] → string[]; coerce a null/garbage value to [].
          linkedContactIds: Array.isArray(row.linked_contact_ids)
            ? row.linked_contact_ids.filter((id) => typeof id === 'string')
            : [],
          // timestamptz → ISO string (or null when active).
          archivedAt: row.archived_at ? new Date(row.archived_at).toISOString() : null,
          // Optional named group; empty column → undefined (ungrouped).
          group: row.group_name ?? undefined,
        })),
        clients: clientsResult.rows.map((row) => {
          // Back-compat normalization. The frontend always gets
          // `planIds: string[]` and `contactIds: string[]` (never undefined),
          // and a `monthlyRate` that prefers the new column, then the legacy
          // per-client custom fee.
          const planIds = Array.isArray(row.plan_ids)
            ? row.plan_ids.filter((id) => typeof id === 'string' && id)
            : []
          const normalizedPlanIds =
            planIds.length > 0
              ? planIds
              : row.plan_id
                ? [row.plan_id]
                : []
          const contactIds = Array.isArray(row.contact_ids)
            ? row.contact_ids.filter((id) => typeof id === 'string' && id)
            : []
          // One assigned team, normalized once. `assignedEmployeeIds` below is
          // an alias of this — it used to come from the `client_assignments`
          // table, which could and did disagree with the column that actually
          // gates visibility.
          const assignedTeam = Array.isArray(row.assigned_bookkeeper_ids)
            ? [...new Set(row.assigned_bookkeeper_ids.filter((id) => typeof id === 'string'))]
            : []
          const monthlyRate =
            row.monthly_rate === null || row.monthly_rate === undefined
              ? row.custom_monthly_fee === null || row.custom_monthly_fee === undefined
                ? null
                : Number(row.custom_monthly_fee)
              : Number(row.monthly_rate)
          return {
            id: row.id,
            name: row.name,
            contact: row.contact,
            billingMode: row.billing_mode,
            hourlyRate: Number(row.hourly_rate),
            planIds: normalizedPlanIds,
            contactIds,
            monthlyRate: monthlyRate === null ? undefined : monthlyRate,
            monthlyServiceTier: row.monthly_service_tier ?? undefined,
            annualRate:
              row.annual_rate === null || row.annual_rate === undefined
                ? undefined
                : Number(row.annual_rate),
            annualBillingMonth:
              row.annual_billing_month === null || row.annual_billing_month === undefined
                ? undefined
                : Number(row.annual_billing_month),
            ...mapEstimatedRoleHours({
              legacy: row.estimated_monthly_hours,
              bookkeeper: row.estimated_bookkeeper_hours,
              accountant: row.estimated_accountant_hours,
              cfo: row.estimated_cfo_hours,
            }),
            // Legacy fields surfaced for back-compat reads + migration only.
            planId: row.plan_id ?? null,
            customMonthlyFee:
              row.custom_monthly_fee === null || row.custom_monthly_fee === undefined
                ? null
                : Number(row.custom_monthly_fee),
            assignedEmployeeIds: assignedTeam,
            assignedBookkeeperIds: assignedTeam,
          email: row.email ?? '',
          contactName: row.contact_name ?? '',
          phone: row.phone ?? '',
          addressLine1: row.address_line1 ?? '',
          addressLine2: row.address_line2 ?? '',
          city: row.city ?? '',
          state: row.state ?? '',
          postalCode: row.postal_code ?? '',
          logoUrl: row.logo_url ?? '',
          paymentTerms: row.payment_terms ?? '',
          footerNote: row.footer_note ?? '',
          quickbooksPayUrl: row.quickbooks_pay_url ?? '',
            invoiceShowTimeBreakdown: row.invoice_show_time_breakdown ?? true,
            invoiceTimeBreakdownMode: normalizeTimeBreakdownMode(row.invoice_time_breakdown_mode),
            invoiceTimeBreakdownAmounts: row.invoice_time_breakdown_amounts ?? false,
            invoiceHideInternalHours: row.invoice_hide_internal_hours ?? true,
            invoiceGroupByCategory: row.invoice_group_by_category ?? false,
            cardPaymentsEnabled: row.card_payments_enabled ?? false,
            // Default 'active' when null so legacy/absent rows are never treated
            // as prospects.
            lifecycleStage: row.lifecycle_stage ?? 'active',
            // Consolidated billing. Null is the ordinary client on both id
            // columns; the boolean answers false for every row written before
            // the column existed. Same shape `normalizeClientProfile` produces
            // for the file backend — cardinal rule 1.
            billToClientId: row.bill_to_client_id ?? null,
            isBillingMaster: row.is_billing_master === true,
            invoiceRecipientClientId: row.invoice_recipient_client_id ?? null,
          }
        }),
        timeEntries: timeEntriesResult.rows.map((row) => ({
          id: row.id,
          employeeId: row.user_id,
          clientId: row.client_id ?? '',
          isAdministrative: Boolean(row.is_administrative),
          isAdhoc: Boolean(row.is_adhoc),
          date: row.entry_date.toISOString().slice(0, 10),
          minutes: Number(row.minutes),
          category: row.category,
          description: row.description,
          billable: row.billable,
          taskId: row.task_id ?? null,
          approvalStatus: row.approval_status ?? 'approved',
          approvalNote: row.approval_note ?? undefined,
          approvedBy: row.approved_by ?? undefined,
          approvedAt: row.approved_at ? row.approved_at.toISOString() : undefined,
          entryMethod: row.entry_method === 'manual' ? 'manual' : 'timer',
          manualReason: row.manual_reason ?? undefined,
          startAt: row.started_at ? row.started_at.toISOString() : undefined,
          endAt: row.ended_at ? row.ended_at.toISOString() : undefined,
          sessions: normalizeStoredSessions(row.sessions, row.started_at, row.ended_at),
          groupId: row.group_id ?? undefined,
          groupClientIds: Array.isArray(row.group_client_ids)
            ? row.group_client_ids.filter((id) => typeof id === 'string' && id)
            : [],
          ...(row.group_allocation ? { groupAllocation: row.group_allocation } : {}),
          ...(row.task_label ? { taskLabel: row.task_label } : {}),
          ...(row.created_at ? { createdAt: row.created_at.toISOString() } : {}),
        })),
        checklists: allChecklists.filter((checklist) => !checklist.deletedAt),
        recycledChecklists: allChecklists.filter((checklist) => Boolean(checklist.deletedAt)),
        checklistTemplates: checklistTemplatesResult.rows.map((row) => ({
          id: row.id,
          title: row.title,
          clientId: row.client_id ?? '',
          assigneeId: row.assignee_id,
          frequency: row.frequency,
          nextDueDate: row.next_due_date ? row.next_due_date.toISOString().slice(0, 10) : '',
          active: row.active,
          isStandard: Boolean(row.is_standard),
          categoryId: row.category_id ?? null,
          // Off unless an owner turned it on — a task whose template has this
          // false must not even show the skip affordance.
          skipAllowed: Boolean(row.skip_allowed),
          periodLabelEnabled: Boolean(row.period_label_enabled),
          periodCoverageStart: row.period_coverage_start
            ? row.period_coverage_start.toISOString().slice(0, 10)
            : null,
          periodCoverageEnd: row.period_coverage_end
            ? row.period_coverage_end.toISOString().slice(0, 10)
            : null,
          periodCoverageAnchorDue: row.period_coverage_anchor_due
            ? row.period_coverage_anchor_due.toISOString().slice(0, 10)
            : null,
          ...(row.onboarding_for_client_id
            ? { onboardingForClientId: row.onboarding_for_client_id }
            : {}),
          ...(row.source_template_id ? { sourceTemplateId: row.source_template_id } : {}),
          viewerIds: Array.isArray(row.viewer_ids) ? row.viewer_ids : [],
          editorIds: Array.isArray(row.editor_ids) ? row.editor_ids : [],
          // Specific-months scheduling fields (only meaningful for that frequency).
          scheduledMonths: Array.isArray(row.scheduled_months)
            ? row.scheduled_months.filter((m) => Number.isInteger(m) && m >= 1 && m <= 12)
            : [],
          ...(typeof row.due_day_of_month === 'number'
            ? { dueDayOfMonth: row.due_day_of_month }
            : {}),
          ...(row.monthly_due_days && typeof row.monthly_due_days === 'object'
            ? { monthlyDueDays: row.monthly_due_days }
            : {}),
          repeatAnnually: row.repeat_annually === null || row.repeat_annually === undefined
            ? true
            : Boolean(row.repeat_annually),
          ...(typeof row.schedule_year === 'number' ? { scheduleYear: row.schedule_year } : {}),
          ...(typeof row.lead_days === 'number' && row.lead_days > 0
            ? { leadDays: row.lead_days }
            : {}),
          stages: stagesByTemplate.get(row.id) ?? [],
          items: templateItemsByTemplate.get(row.id) ?? [],
        })),
        timesheetLocks: timesheetLocksResult.rows.map((row) => ({
          id: row.id,
          userId: row.user_id,
          period: row.period,
          lockedBy: row.locked_by,
          lockedAt: row.locked_at ? row.locked_at.toISOString() : nowIso(),
        })),
        weeklySubmissions: weeklySubmissionsResult.rows.map((row) => ({
          id: row.id,
          userId: row.user_id,
          weekStart: row.week_start.toISOString().slice(0, 10),
          submittedAt: row.submitted_at ? row.submitted_at.toISOString() : nowIso(),
          status: row.status,
          ...(row.reviewed_by ? { reviewedBy: row.reviewed_by } : {}),
          ...(row.reviewed_at ? { reviewedAt: row.reviewed_at.toISOString() } : {}),
          ...(row.review_note ? { reviewNote: row.review_note } : {}),
        })),
        reimbursements: reimbursementsResult.rows.map((row) => ({
          id: row.id,
          clientId: row.client_id,
          date: row.date.toISOString().slice(0, 10),
          description: row.description,
          amount: Number(row.amount),
        })),
        recurringReimbursements: recurringReimbursementsResult.rows.map(
          mapRecurringReimbursementRow,
        ),
        inactiveEmployees: inactiveUsersResult.rows.map((row) => ({
          id: row.id,
          name: row.name,
          role: dbRoleToEmployeeRole(row.role),
          billRate: row.bill_rate == null ? null : Number(row.bill_rate),
          inactiveAt: row.inactive_at ? row.inactive_at.toISOString() : null,
        })),
      }

      // PREVIOUSLY: when `data.checklistTemplates.length === 0` we re-injected
      // the seed templates on every read as a safety net. That turned every
      // page reload into a re-seed loop for any workspace whose templates
      // had been intentionally cleared (e.g., after the user deleted all
      // their clients) — the seed templates carry past `nextDueDate`s and
      // orphan `clientId`s pointing at the seed clients, so the materializer
      // immediately backfilled fresh checklists for every missed period.
      // Those checklists were then dropped by the bulk-save orphan filter
      // on the writeback, but the response returned the spawned data anyway,
      // so the user saw "ALL the checklists are back again" every refresh.
      // Workspace setup belongs to the user, not to a silent reload effect.
      // First-time bootstrap is still handled by `seedRelationalDataInPostgres`
      // (which only fires when the clients table is empty during init).

      data.firmSettings = await this.getFirmSettings()

      return data
    }
  }

  async read() {
    if (this.pool) {
      const data = await this._readPostgresWorkspace()
      const materialized = materializeRecurringChecklists(data)
      if (!materialized.changed) {
        return data
      }

      // Persist the freshly-materialized checklists — GUARDED. The write-back
      // is a full wipe-and-reinsert, so a write that landed while we were
      // reading (a waiting-on entry, a checklist edit) would be silently
      // erased by an unguarded save of our now-stale snapshot. The order
      // below is what makes the guard sound: capture the persisted
      // fingerprint FIRST, then re-read, so the snapshot handed to write()
      // is never older than the fingerprint it is written under. write()
      // re-checks the fingerprint inside its transaction and refuses with
      // StaleWorkspaceError if anything moved — in which case we serve the
      // in-memory data and let the next read retry. The double read only
      // happens when a spawn is actually due (rare), so ordinary page loads
      // pay nothing.
      //
      // And NEVER let a failure here 500 the read. read() runs on every page
      // load; if this write-back throws (e.g. a constraint violation on one
      // bad row), an unguarded throw turns a single bad record into a TOTAL
      // outage for every user (the 2026-06-17 incident).
      let served = materialized.data
      try {
        const expectedVersion = await postgresWorkspaceVersion(this.pool)
        const fresh = await this._readPostgresWorkspace()
        const freshMaterialized = materializeRecurringChecklists(fresh)
        if (!freshMaterialized.changed) {
          // Another server (or a concurrent read) already persisted the spawn.
          return fresh
        }
        served = freshMaterialized.data
        await this.write(freshMaterialized.data, { expectedVersion })
        return freshMaterialized.data
      } catch (error) {
        if (error instanceof StaleWorkspaceError) {
          console.warn(
            `[read] materialize write-back skipped: workspace moved to ${error.currentVersion} mid-read; serving in-memory data`,
          )
        } else {
          console.error('[read] materialize write-back failed; serving in-memory data:', error)
        }
        // The freshest snapshot we materialized (the re-read when it got that
        // far, the first read otherwise). Its spawned ids were never
        // persisted; the next read's write-back mints its own.
        return served
      }
    }

    const data = await readJson(localDataPath)
    // Fingerprint of the persisted file EXACTLY as read, captured before any
    // in-place backfill below mutates `data` — this is what the guarded
    // write-back at the bottom is compared against.
    const persistedVersion = fileWorkspaceVersion(data)
    if (!Array.isArray(data.checklistTemplates)) {
      const seed = await this.getSeedData()
      data.checklistTemplates = seed.checklistTemplates ?? []
    }
    if (Array.isArray(data.clients)) {
      data.clients = data.clients.map(normalizeClientProfile)
    }
    data.firmSettings = { ...DEFAULT_FIRM_SETTINGS, ...(data.firmSettings || {}) }

    // Carry each employee's BILL rate onto `data.employees` so it reaches the
    // client (getInvoice needs it), mirroring the Postgres employees mapping
    // above. In the file backend the rate lives in the separate auth store
    // (set by setEmployeeBillRate); merge it in by id. Inactive employees get
    // the same treatment so historical reports can value their hours too.
    try {
      const authState = await readJson(localAuthPath)
      const billRateById = new Map(
        (Array.isArray(authState.users) ? authState.users : [])
          .filter((u) => u && typeof u.id === 'string')
          .map((u) => [u.id, typeof u.billRate === 'number' ? u.billRate : null]),
      )
      const withBillRate = (employee) =>
        employee && typeof employee.id === 'string'
          ? { ...employee, billRate: billRateById.get(employee.id) ?? null }
          : employee
      if (Array.isArray(data.employees)) {
        data.employees = data.employees.map(withBillRate)
      }
      if (Array.isArray(data.inactiveEmployees)) {
        data.inactiveEmployees = data.inactiveEmployees.map(withBillRate)
      }
    } catch {
      // A missing/malformed auth file must never block a read. Employees just
      // carry no billRate (treated as null → defaultHourlyRate fallback).
    }

    // Backfill the approval workflow for legacy file-fallback data. An entry
    // with no `approvalStatus` predates the feature, so it's treated as
    // 'approved' — no giant pending backlog on first run. An entry with no
    // `entryMethod` predates manual entry, so it reads as 'timer'. Persisted
    // below if anything changed so the backfill happens exactly once.
    let backfilled = false
    if (Array.isArray(data.timeEntries)) {
      data.timeEntries = data.timeEntries.map((entry) => {
        const needsApproval = !entry || typeof entry.approvalStatus !== 'string'
        const needsMethod = !entry || typeof entry.entryMethod !== 'string'
        if (!needsApproval && !needsMethod) return entry
        backfilled = true
        return {
          ...entry,
          ...(needsApproval ? { approvalStatus: 'approved' } : {}),
          ...(needsMethod ? { entryMethod: 'timer' } : {}),
        }
      })
    }
    if (!Array.isArray(data.timesheetLocks)) {
      data.timesheetLocks = []
      backfilled = true
    }

    if (!Array.isArray(data.weeklySubmissions)) {
      data.weeklySubmissions = []
      backfilled = true
    }

    if (!Array.isArray(data.reimbursements)) {
      data.reimbursements = []
      backfilled = true
    }

    if (!Array.isArray(data.recurringReimbursements)) {
      data.recurringReimbursements = []
      backfilled = true
    }

    if (!Array.isArray(data.inactiveEmployees)) {
      data.inactiveEmployees = []
      backfilled = true
    }

    if (!Array.isArray(data.contacts)) {
      data.contacts = []
      backfilled = true
    }

    // One-time idempotent contacts backfill from legacy client contact fields.
    // Only clients with empty contactIds are touched, so reboots never dupe.
    if (this.backfillContactsFromClientsInFile(data)) {
      backfilled = true
    }

    // Recycle-bin backfill for legacy file-fallback data. Old saves never
    // carried a separate array, so partition the existing list by `deletedAt`
    // and keep both arrays from now on. New saves always write both arrays
    // explicitly so this branch only fires once.
    if (!Array.isArray(data.recycledChecklists)) {
      const active = []
      const recycled = []
      for (const checklist of Array.isArray(data.checklists) ? data.checklists : []) {
        if (checklist && checklist.deletedAt) {
          recycled.push(checklist)
        } else {
          active.push(checklist)
        }
      }
      data.checklists = active
      data.recycledChecklists = recycled
      backfilled = true
    }

    const materialized = materializeRecurringChecklists(data)
    if (materialized.changed || backfilled) {
      // Same guarded write-back as the Postgres branch above: the fingerprint
      // captured right after the file was read gates the save, so a write that
      // landed mid-read refuses this snapshot instead of being erased by it.
      // Scope caveat: the fingerprint covers BULK_SAVE_SLICES + employees
      // (lib/workspace-version.js) — a mid-read write to a slice OUTSIDE that
      // set (invoices, firmSettings, serviceCategories) does not move it and
      // is still overwritten by this whole-file save. Postgres doesn't share
      // that hole (its write() only touches the fingerprinted tables and
      // restores invoices explicitly); file mode is dev/test only.
      // A refused (or failed) write-back serves the in-memory data and lets
      // the next read retry — never 500s the read.
      try {
        await this.write(materialized.data, { expectedVersion: persistedVersion })
      } catch (error) {
        if (error instanceof StaleWorkspaceError) {
          console.warn(
            `[read] materialize write-back skipped: workspace moved ${persistedVersion} -> ${error.currentVersion}; serving in-memory data`,
          )
        } else {
          console.error('[read] materialize write-back failed; serving in-memory data:', error)
        }
      }
      return materialized.data
    }

    return data
  }

  /**
   * Bulk workspace save — wipes and re-inserts every table listed in
   * `BULK_SAVE_TABLES` from `data`.
   *
   * @param {object} data - the full workspace snapshot to persist.
   * @param {{ expectedVersion?: string | null }} [options]
   *   `expectedVersion` is the staleness guard: when supplied, the persisted
   *   workspace's current fingerprint must still match it or the save is
   *   refused with `StaleWorkspaceError` and NOTHING is written. The comparison
   *   happens INSIDE the transaction (and inside the file queue), so there is
   *   no check-then-write window for a concurrent save to slip through.
   *
   *   `read()`'s materializer write-back passes it too (fingerprint captured
   *   before the snapshot it writes was read), so a spawn racing a real write
   *   refuses itself instead of erasing the write. Omit it only for internal
   *   read-modify-write helpers where last-writer-wins is acceptable.
   */
  async write(data, { expectedVersion = null } = {}) {
    // SECURITY (L1/L2): normalize/clamp clearly-bad values IN PLACE before
    // either persistence branch. This NEVER rejects a save — a normal blob
    // passes through unchanged; only garbage (negative/huge numbers, invalid
    // dates, non-object records, missing arrays) is cleaned so one bad value
    // can't crash the bulk wipe-and-reinsert or persist unparseable data.
    data = sanitizeAppData(data)

    if (this.pool) {
      const client = await this.pool.connect()

      // Defensive: drop any records that reference an FK target no longer
      // present in this snapshot. Without this guard, an in-memory delete
      // (client / template / employee) that leaves stale references behind
      // wedges every subsequent bulk save with an FK violation. The schema
      // CASCADEs on delete server-side; this just mirrors that behavior for
      // local-only mutations that never round-tripped.
      // IMPORTANT: We only filter rows that reference tables we wipe and
      // re-insert in this transaction (clients, checklist_templates).
      // We do NOT filter on user/employee refs because the `users` table
      // is NOT wiped on bulk save — any assignee_id that was valid before
      // is still valid via users. Filtering on the client's view of
      // employees was a bug that caused standard templates (with seed
      // assignees not present in data.employees) to be dropped, taking
      // their dependent checklists with them.
      const validClientIds = new Set(
        Array.isArray(data.clients) ? data.clients.map((c) => c.id) : [],
      )
      // Filled in after we filter templates (so checklists can validate
      // their template_id refs against the post-filter set). Declared up
      // front so the closure below doesn't hit a TDZ on first call.
      const validTemplateIds = new Set()

      const filterOrphans = (rows, label, getRefs) =>
        filterBulkSaveOrphans(rows, { validClientIds, validTemplateIds, label, getRefs })

      // Templates first — checklists may reference them, so we need the
      // post-filter id set to validate template_id refs on checklists.
      // Standard templates legitimately have no client_id — leave those.
      const safeTemplates = filterOrphans(
        data.checklistTemplates,
        'checklist_templates',
        (t) => ({ clientId: t && t.clientId ? t.clientId : null }),
      )
      for (const t of safeTemplates) validTemplateIds.add(t.id)

      // IMPORTANT: only check `clientId`. The `template_id` column on
      // `checklists` has NO foreign-key constraint (it's a plain nullable
      // text column — see the schema in this file). Dropping checklists
      // whose templateId isn't in the post-filter template set was an
      // over-zealous defensive guard that silently nuked recycled-bin
      // tombstones whenever a referenced template was filtered out. With
      // the tombstone gone, the next read's materializer saw no record
      // of the deleted instance for the current period and respawned it
      // — the exact "checklist comes back after delete" symptom users hit.
      const safeChecklists = filterOrphans(
        data.checklists,
        'checklists',
        (c) => ({ clientId: c?.clientId }),
      )
      const safeRecycledChecklists = filterOrphans(
        data.recycledChecklists,
        'recycledChecklists',
        (c) => ({ clientId: c?.clientId }),
      )
      const safeReimbursements = filterOrphans(
        data.reimbursements,
        'reimbursements',
        (r) => ({ clientId: r?.clientId }),
      )
      const safeRecurringReimbursements = filterOrphans(
        data.recurringReimbursements,
        'recurring_reimbursements',
        (r) => ({ clientId: r?.clientId }),
      )
      const safeTimeEntries = filterOrphans(
        data.timeEntries,
        'time_entries',
        (e) => ({ clientId: e?.clientId }),
      )

      // Nothing to filter on a client's assigned team: it lives in the
      // `assigned_bookkeeper_ids` text[] column, which carries no FK. The
      // `client_assignments` table this used to rebuild is inert (see
      // docs/plans/client-assignment-single-source-2026-08.md).
      const safeClients = Array.isArray(data.clients) ? data.clients : []

      // Valid plan ids for this payload. Used to strip dangling plan
      // references off clients before insert (see `sanitizeClientPlanRefs` —
      // an orphaned plan_ids entry once 500-ed every read and took the app
      // offline).
      const validPlanIds = new Set(
        (Array.isArray(data.plans) ? data.plans : [])
          .map((plan) => plan?.id)
          .filter((id) => typeof id === 'string' && id),
      )

      // Valid user ids for FK-bearing user references. The bulk write NEVER
      // deletes users (it upserts), so the live set is everyone already in
      // `users` plus everyone in this payload's employees. A client_assignment
      // or weekly_submission pointing at a user in neither would violate its FK
      // and abort the whole transaction; we drop those orphans below (a
      // genuinely-deleted user would have cascade-removed them anyway). Users
      // aren't deleted in normal operation (deleteTeamMember soft-deletes), so
      // this is defensive — but one orphan must never wedge the save again.
      const existingUserIds = (await this.pool.query('select id from users')).rows.map(
        (row) => row.id,
      )
      const validUserIds = new Set([
        ...existingUserIds,
        ...(Array.isArray(data.employees) ? data.employees : [])
          .map((employee) => employee?.id)
          .filter((id) => typeof id === 'string' && id),
      ])

      try {
        await client.query('begin')

        // Staleness guard, INSIDE the transaction. Running it here (rather than
        // in the endpoint before calling write) means a concurrent save cannot
        // land between the check and the deletes below.
        // Throwing here lands in this try's catch, which issues the rollback —
        // no second rollback needed (a redundant one only logs a warning).
        if (expectedVersion) {
          const currentVersion = await postgresWorkspaceVersion(client)
          if (currentVersion !== expectedVersion) {
            throw new StaleWorkspaceError(currentVersion)
          }
        }

        // `invoices` is NOT part of the bulk-save payload — the app never sends
        // invoices through the workspace save, so `data` carries none to
        // re-insert. They still have to be DELETED below: `client_id` is
        // `on delete restrict`, so `delete from clients` cannot run while any
        // invoice row exists. Snapshot them here and put them back after the
        // clients are re-inserted (see the restore loop below).
        //
        // Without that restore this would be the ONE table of the fifteen wiped
        // here with a delete and no matching insert — and unlike the empty
        // placeholder it replaces, this one holds real money. The first invoice
        // Brittany generated would vanish on the next owner autosave, silently.
        const preservedInvoices = (
          await client.query(
            `select id, client_id, period, number, kind, status, line_items, subtotal, total,
                    due_date, blurb, scope_flags, sent_at, paid_at,
                    stripe_checkout_session_id, stripe_card_session_id,
                    stripe_payment_intent_id, payment_method,
                    email_log, applied_to_invoice_id, original_line_items, created_at
               from invoices`,
          )
        ).rows

        // Creation dates are DATA, not bookkeeping — and this transaction was
        // erasing them. Every insert below omitted `created_at`, so each wipe
        // and re-insert let the column's `default now()` fire again: in
        // production all 753 checklists claimed to have been created on the day
        // of the most recent autosave. (Those original dates are gone and are
        // not recoverable; this stops the loss from here on.)
        //
        // Same technique as the invoice restore above — snapshot INSIDE the
        // transaction, before the deletes, and supply the value on re-insert.
        // Deliberately NOT taken from the payload: `read()` doesn't even send
        // most of these, and a stale tab that did carry one could rewrite
        // history. A row with no snapshot entry is genuinely new and falls back
        // to now().
        const preservedCreatedAt = new Map()
        for (const table of CREATED_AT_PRESERVED_TABLES) {
          const snapshot = await client.query(`select id, created_at from ${table}`)
          preservedCreatedAt.set(table, new Map(snapshot.rows.map((row) => [row.id, row.created_at])))
        }
        const createdAtFor = (table, id) => preservedCreatedAt.get(table)?.get(id) ?? new Date()

        // Covered-date state, snapshotted for the same reason and by the same
        // technique as the two above.
        //
        // `recurring_reimbursements` IS in the bulk-save payload — unlike
        // `invoices` — so a tab CAN legitimately rewrite an expense's
        // description, amount, frequency and covered-date SETUP. What it must
        // never rewrite is the part generation and confirmation own: the ledger
        // of which window each period was billed for, the cycle's anchor day,
        // and the pending-resume flag. A tab that loaded this morning holds an
        // empty ledger; its autosave this afternoon, after a month run, would
        // otherwise restart every expense at its seed window and re-bill windows
        // already sent. Stored wins, always.
        const preservedCoverageById = new Map(
          (
            await client.query(
              `select id, coverage_anchor_day, coverage_resume_pending, coverage_history
                 from recurring_reimbursements`,
            )
          ).rows.map((row) => [
            row.id,
            {
              coverageAnchorDay: row.coverage_anchor_day,
              coverageResumePending: row.coverage_resume_pending,
              coverageHistory: row.coverage_history,
            },
          ]),
        )
        // A row with no snapshot entry is genuinely new — the payload's value is
        // all there is, and for a brand-new expense that is exactly right.
        const preservedCoverage = (recurring, field) => {
          const stored = preservedCoverageById.get(recurring.id)
          if (stored) return stored[field]
          if (field === 'coverageHistory') return recurring.coverageHistory ?? {}
          if (field === 'coverageAnchorDay') {
            return anchorDayFromRange(recurring.coverageEnd) ?? null
          }
          return Boolean(recurring.coverageResumePending)
        }

        // Completion stamps, for the same reason and with the same rule (see
        // `preservedItemCompletion`): the payload's copy is ignored, the stored
        // one wins, and only a step this save actually completes gets now().
        //
        // The same snapshot carries the WAITING state, for a stronger version of
        // the same rule: a bulk payload may not create, alter or erase a saved
        // wait at all (see `preservedNodeWaits`). One query rather than two —
        // the rows are the same rows.
        const priorItemRows = (
          await client.query(
            `select id, done, completed_at, waiting, waiting_on, waiting_for_checklist_id, waiting_ons, sub_items from checklist_items`,
          )
        ).rows
        const priorItemCompletion = new Map(
          priorItemRows.map((row) => [row.id, { done: row.done, completedAt: row.completed_at }]),
        )
        const priorItemWaits = new Map(
          priorItemRows.map((row) => [
            row.id,
            {
              waiting: row.waiting,
              waitingOn: row.waiting_on,
              waitingForChecklistId: row.waiting_for_checklist_id,
              waitingOns: row.waiting_ons,
              subItems: normalizeSubItems(row.sub_items, { withDone: true }),
            },
          ]),
        )

        await client.query('delete from checklist_items')
        await client.query('delete from checklists')
        await client.query('delete from checklist_template_items')
        await client.query('delete from checklist_template_stages')
        await client.query('delete from checklist_templates')
        await client.query('delete from time_entries')
        await client.query('delete from timesheet_locks')
        await client.query('delete from weekly_submissions')
        await client.query('delete from reimbursements')
        await client.query('delete from recurring_reimbursements')
        await client.query('delete from invoices')
        await client.query('delete from clients')
        await client.query('delete from subscription_plans')
        await client.query('delete from contacts')

        for (const employee of data.employees) {
          // SECURITY (H4): the bulk save is owner-writable and re-inserts
          // every employee, but it must NEVER be a path to escalate
          // privileges, hijack an email, or overwrite a credential. There
          // is no role-edit server endpoint and the Team UI only sets a
          // role at invite time (via the separate createTeamMember path),
          // so a bulk save legitimately changes ONLY a member's name.
          //
          // ON CONFLICT therefore updates name + updated_at ONLY — role,
          // staff_role, email and password_hash are all PRESERVED on an
          // existing row (a crafted/compromised owner payload can't promote
          // someone to owner, steal their email, or reset their password).
          //
          // On a FIRST insert (id not yet in users) we default to the
          // NON-owner role and a RANDOM, unknowable password — the bulk
          // path can never mint an owner or a known default credential.
          // Real owners/members are created exclusively by the invite
          // endpoint (createTeamMember), which is untouched. Email is
          // still the `${id}@pbj.local` placeholder on first insert and is
          // preserved via coalesce on every subsequent save (so a real
          // address the owner later set for magic-link sign-in is kept).
          await client.query(
            `
              insert into users (id, name, email, role, staff_role, password_hash, updated_at)
              values (
                $1,
                $2,
                coalesce((select email from users where id = $1), $3),
                $4,
                $5,
                coalesce((select password_hash from users where id = $1), $6),
                now()
              )
              on conflict (id) do update
              set name = excluded.name,
                  updated_at = now()
            `,
            [
              employee.id,
              employee.name,
              `${employee.id}@pbj.local`,
              roleToDbRole('Bookkeeper'),
              'Bookkeeper',
              hashPassword(randomBytes(32).toString('base64url')),
            ],
          )
        }

        for (const plan of data.plans) {
          // Pricing left the plan model — only name + notes are written now.
          // The legacy monthly_fee / included_hours columns keep their DB
          // defaults (0) and are otherwise ignored.
          // template_ids is FK-free (a listed template may since have been
          // deleted); coerce to a clean string[] so a malformed payload can't
          // break the insert. The board link is transitive via each template's
          // category, so no extra normalization is needed here.
          const planTemplateIds = Array.isArray(plan.templateIds)
            ? plan.templateIds.filter((id) => typeof id === 'string' && id)
            : []
          await client.query(
            `
              insert into subscription_plans (id, name, notes, template_ids, created_at, updated_at)
              values ($1, $2, $3, $4::text[], $5, now())
            `,
            [
              plan.id,
              plan.name,
              plan.notes ?? '',
              planTemplateIds,
              createdAtFor('subscription_plans', plan.id),
            ],
          )
        }

        for (const contact of data.contacts ?? []) {
          // Normalize the new fields so a malformed payload can't break the
          // insert: company_emails as clean jsonb, linked ids as a text[],
          // archived_at as a timestamp-or-null.
          const companyEmails = parseCompanyEmails(contact.companyEmails)
          const linkedContactIds = Array.isArray(contact.linkedContactIds)
            ? contact.linkedContactIds.filter((id) => typeof id === 'string')
            : []
          const archivedAt =
            typeof contact.archivedAt === 'string' && contact.archivedAt ? contact.archivedAt : null
          // Optional group: trim, store null when empty.
          const groupName =
            typeof contact.group === 'string' && contact.group.trim() ? contact.group.trim() : null
          await client.query(
            `
              insert into contacts (
                id, name, email, phone, title, notes, locked,
                company_emails, linked_contact_ids, archived_at, group_name,
                created_at, updated_at
              )
              values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::text[], $10, $11, $12, now())
            `,
            [
              contact.id,
              contact.name,
              contact.email ?? null,
              contact.phone ?? null,
              contact.title ?? null,
              contact.notes ?? null,
              Boolean(contact.locked),
              JSON.stringify(companyEmails),
              linkedContactIds,
              archivedAt,
              groupName,
              createdAtFor('contacts', contact.id),
            ],
          )
        }

        for (const clientRecord of safeClients) {
          // FK-safe plan references: drop any plan id not present in this
          // payload's plans (see sanitizeClientPlanRefs).
          const planRefs = sanitizeClientPlanRefs(clientRecord, validPlanIds)
          await client.query(
            `
              insert into clients (
                id, name, contact, billing_mode, hourly_rate, plan_id,
                custom_monthly_fee, monthly_rate, estimated_monthly_hours,
                plan_ids, contact_ids,
                email, contact_name, phone, address_line1, address_line2,
                city, state, postal_code, logo_url, payment_terms,
                footer_note, quickbooks_pay_url, invoice_show_time_breakdown,
                invoice_hide_internal_hours, invoice_group_by_category,
                assigned_bookkeeper_ids,
                estimated_bookkeeper_hours, estimated_accountant_hours,
                estimated_cfo_hours, monthly_service_tier,
                annual_rate, annual_billing_month, lifecycle_stage,
                card_payments_enabled,
                invoice_time_breakdown_mode, invoice_time_breakdown_amounts,
                bill_to_client_id, is_billing_master, invoice_recipient_client_id,
                created_at, updated_at
              )
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36, $37, $38, $39, $40, $41, now())
            `,
            [
              clientRecord.id,
              clientRecord.name,
              clientRecord.contact,
              clientRecord.billingMode,
              clientRecord.hourlyRate,
              // Legacy single plan_id: derived from planIds[0] (or the legacy
              // field), but only when that plan still exists — a dangling id
              // here would violate the FK and abort the whole write.
              planRefs.planId,
              clientRecord.customMonthlyFee === undefined || clientRecord.customMonthlyFee === null
                ? null
                : Number(clientRecord.customMonthlyFee),
              clientRecord.monthlyRate === undefined || clientRecord.monthlyRate === null
                ? null
                : Number(clientRecord.monthlyRate),
              clientRecord.estimatedMonthlyHours === undefined ||
              clientRecord.estimatedMonthlyHours === null
                ? null
                : Number(clientRecord.estimatedMonthlyHours),
              planRefs.planIds,
              Array.isArray(clientRecord.contactIds)
                ? clientRecord.contactIds.filter((id) => typeof id === 'string' && id)
                : [],
              clientRecord.email ?? '',
              clientRecord.contactName ?? '',
              clientRecord.phone ?? '',
              clientRecord.addressLine1 ?? '',
              clientRecord.addressLine2 ?? '',
              clientRecord.city ?? '',
              clientRecord.state ?? '',
              clientRecord.postalCode ?? '',
              clientRecord.logoUrl ?? '',
              clientRecord.paymentTerms ?? '',
              clientRecord.footerNote ?? '',
              // Only persist a safe http(s) pay link — never a javascript:/data: URL.
              isSafeHttpUrl(clientRecord.quickbooksPayUrl) ? clientRecord.quickbooksPayUrl : '',
              clientRecord.invoiceShowTimeBreakdown ?? true,
              clientRecord.invoiceHideInternalHours ?? true,
              clientRecord.invoiceGroupByCategory ?? false,
              Array.isArray(clientRecord.assignedBookkeeperIds)
                ? clientRecord.assignedBookkeeperIds
                : [],
              clientRecord.estimatedBookkeeperHours === undefined ||
              clientRecord.estimatedBookkeeperHours === null
                ? null
                : Number(clientRecord.estimatedBookkeeperHours),
              clientRecord.estimatedAccountantHours === undefined ||
              clientRecord.estimatedAccountantHours === null
                ? null
                : Number(clientRecord.estimatedAccountantHours),
              clientRecord.estimatedCfoHours === undefined ||
              clientRecord.estimatedCfoHours === null
                ? null
                : Number(clientRecord.estimatedCfoHours),
              typeof clientRecord.monthlyServiceTier === 'string' &&
              clientRecord.monthlyServiceTier.trim()
                ? clientRecord.monthlyServiceTier
                : null,
              clientRecord.annualRate === undefined || clientRecord.annualRate === null
                ? null
                : Number(clientRecord.annualRate),
              clientRecord.annualBillingMonth === undefined ||
              clientRecord.annualBillingMonth === null
                ? null
                : Number(clientRecord.annualBillingMonth),
              coerceLifecycleStage(clientRecord.lifecycleStage),
              clientRecord.cardPaymentsEnabled ?? false,
              normalizeTimeBreakdownMode(clientRecord.invoiceTimeBreakdownMode),
              clientRecord.invoiceTimeBreakdownAmounts === true,
              // Already resolved against this payload by `sanitizeAppData` at
              // the top of write() — a dangling id never reaches the column.
              clientRecord.billToClientId ?? null,
              clientRecord.isBillingMaster === true,
              clientRecord.invoiceRecipientClientId ?? null,
              createdAtFor('clients', clientRecord.id),
            ],
          )
        }

        // Put back the invoices snapshotted before the wipe, now that their
        // clients exist again. An invoice whose client is gone from this
        // payload is dropped — the same rule every other client-scoped table
        // here follows (a removed client's rows do not come back), and its FK
        // would refuse the insert anyway. `updated_at` is re-stamped like
        // every other row re-inserted by this transaction; `created_at` is
        // preserved so an invoice keeps its real age across a bulk save.
        //
        // This is a MONEY table: an invoice that has been sent or paid must
        // survive an unrelated owner autosave untouched, so every column is
        // restored verbatim rather than regenerated.
        for (const invoice of preservedInvoices) {
          if (!validClientIds.has(invoice.client_id)) continue
          await client.query(
            `
              insert into invoices (
                id, client_id, period, number, kind, status, line_items, subtotal, total,
                due_date, blurb, scope_flags, sent_at, paid_at,
                stripe_checkout_session_id, stripe_card_session_id,
                stripe_payment_intent_id, payment_method,
                email_log, applied_to_invoice_id, original_line_items, created_at, updated_at
              )
              values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19::jsonb,$20,$21::jsonb,$22, now())
            `,
            [
              invoice.id,
              invoice.client_id,
              invoice.period,
              invoice.number,
              // Both new columns ride the restore verbatim like every other one.
              // A retainer that came back as 'monthly' would collide with the
              // client's real invoice for that month on the very next generate;
              // one that came back unapplied would be spendable a second time.
              invoice.kind ?? 'monthly',
              invoice.status,
              JSON.stringify(invoice.line_items ?? []),
              invoice.subtotal,
              invoice.total,
              invoice.due_date,
              invoice.blurb ?? '',
              JSON.stringify(invoice.scope_flags ?? []),
              invoice.sent_at,
              invoice.paid_at,
              invoice.stripe_checkout_session_id,
              invoice.stripe_card_session_id,
              invoice.stripe_payment_intent_id,
              invoice.payment_method,
              JSON.stringify(invoice.email_log ?? []),
              invoice.applied_to_invoice_id ?? null,
              // Rides the restore like every other column, and keeps its NULL
              // rather than being coerced to `[]` — see the migration above.
              // A snapshot column added to one half of this pair and not the
              // other is the exact shape of the three past data-loss bugs.
              invoice.original_line_items ? JSON.stringify(invoice.original_line_items) : null,
              invoice.created_at,
            ],
          )
        }

        for (const entry of safeTimeEntries) {
          await client.query(
            `
              insert into time_entries (id, user_id, client_id, entry_date, minutes, category, description, billable, task_id,
                                        approval_status, approval_note, approved_by, approved_at, entry_method, manual_reason, is_administrative,
                                        is_adhoc, started_at, ended_at, sessions, group_id, group_client_ids, group_allocation, task_label, created_at, updated_at)
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21, $22, $23, $24, $25, now())
            `,
            [
              entry.id,
              entry.employeeId,
              // Administrative entries have no client — persist NULL.
              entry.clientId || null,
              entry.date,
              entry.minutes,
              entry.category ?? 'General',
              entry.description,
              entry.billable,
              entry.taskId ?? null,
              entry.approvalStatus ?? 'approved',
              entry.approvalNote ?? null,
              entry.approvedBy ?? null,
              entry.approvedAt ?? null,
              entry.entryMethod === 'manual' ? 'manual' : 'timer',
              entry.entryMethod === 'manual' ? entry.manualReason ?? null : null,
              Boolean(entry.isAdministrative),
              Boolean(entry.isAdhoc),
              entry.startAt ?? null,
              entry.endAt ?? null,
              JSON.stringify(Array.isArray(entry.sessions) ? entry.sessions : []),
              entry.groupId ? String(entry.groupId) : null,
              Array.isArray(entry.groupClientIds)
                ? entry.groupClientIds.filter((id) => typeof id === 'string' && id)
                : [],
              normalizeGroupAllocation(entry.groupAllocation),
              entry.taskId ? null : entry.taskLabel ? String(entry.taskLabel) : null,
              // Preserve the original creation time across the wipe-and-rewrite
              // so "most recently logged" ordering survives a bulk save.
              entry.createdAt ? new Date(entry.createdAt) : nowIso(),
            ],
          )
        }

        for (const lock of data.timesheetLocks ?? []) {
          await client.query(
            `
              insert into timesheet_locks (id, user_id, period, locked_by, locked_at)
              values ($1, $2, $3, $4, $5)
            `,
            [lock.id, lock.userId, lock.period, lock.lockedBy, lock.lockedAt ?? nowIso()],
          )
        }

        for (const submission of (data.weeklySubmissions ?? []).filter(
          (submission) => submission && validUserIds.has(submission.userId),
        )) {
          await client.query(
            `
              insert into weekly_submissions (id, user_id, week_start, submitted_at, status, reviewed_by, reviewed_at, review_note)
              values ($1, $2, $3, $4, $5, $6, $7, $8)
            `,
            [
              submission.id,
              submission.userId,
              submission.weekStart,
              submission.submittedAt ?? nowIso(),
              submission.status,
              submission.reviewedBy ?? null,
              submission.reviewedAt ?? null,
              submission.reviewNote ?? null,
            ],
          )
        }

        for (const reimbursement of safeReimbursements) {
          await client.query(
            `
              insert into reimbursements (id, client_id, date, description, amount, created_at, updated_at)
              values ($1, $2, $3, $4, $5, $6, now())
            `,
            [
              reimbursement.id,
              reimbursement.clientId,
              reimbursement.date,
              reimbursement.description,
              reimbursement.amount,
              createdAtFor('reimbursements', reimbursement.id),
            ],
          )
        }

        for (const recurring of safeRecurringReimbursements) {
          await client.query(
            `
              insert into recurring_reimbursements
                (id, client_id, description, amount, frequency, start_date,
                 coverage_enabled, coverage_template, coverage_start, coverage_end,
                 coverage_anchor_day, coverage_paused, coverage_resume_pending, coverage_history,
                 created_at, updated_at)
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, now())
            `,
            [
              recurring.id,
              recurring.clientId,
              recurring.description,
              recurring.amount,
              recurring.frequency,
              recurring.startDate,
              Boolean(recurring.coverageEnabled),
              recurring.coverageTemplate ?? null,
              recurring.coverageStart || null,
              recurring.coverageEnd || null,
              // The ledger, the anchor and the resume flag are NEVER taken from
              // the payload — see `preservedCoverage`. A tab that loaded before
              // a month run holds an empty ledger, and letting it win would
              // restart every expense's cycle at its seed window.
              preservedCoverage(recurring, 'coverageAnchorDay'),
              Boolean(recurring.coveragePaused),
              preservedCoverage(recurring, 'coverageResumePending'),
              JSON.stringify(preservedCoverage(recurring, 'coverageHistory') ?? {}),
              createdAtFor('recurring_reimbursements', recurring.id),
            ],
          )
        }

        for (const template of safeTemplates) {
          await client.query(
            `
              insert into checklist_templates (id, title, client_id, assignee_id, frequency, next_due_date, active, is_standard, viewer_ids, editor_ids, scheduled_months, due_day_of_month, monthly_due_days, repeat_annually, schedule_year, lead_days, category_id, source_template_id, onboarding_for_client_id, skip_allowed, period_label_enabled, period_coverage_start, period_coverage_end, period_coverage_anchor_due, created_at, updated_at)
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, now())
            `,
            [
              template.id,
              template.title,
              // Standard templates are client-agnostic — client_id may be empty.
              template.clientId ? template.clientId : null,
              template.assigneeId,
              template.frequency,
              // Specific-months templates have no next-due date.
              template.nextDueDate ? template.nextDueDate : null,
              template.active,
              Boolean(template.isStandard),
              Array.isArray(template.viewerIds) ? template.viewerIds : [],
              Array.isArray(template.editorIds) ? template.editorIds : [],
              Array.isArray(template.scheduledMonths)
                ? template.scheduledMonths.filter((m) => Number.isInteger(m) && m >= 1 && m <= 12)
                : [],
              typeof template.dueDayOfMonth === 'number' ? template.dueDayOfMonth : null,
              template.monthlyDueDays && typeof template.monthlyDueDays === 'object'
                ? JSON.stringify(template.monthlyDueDays)
                : null,
              // Defaults to true (repeat every year) when unset.
              template.repeatAnnually === false ? false : true,
              typeof template.scheduleYear === 'number' ? template.scheduleYear : null,
              typeof template.leadDays === 'number' && template.leadDays > 0
                ? Math.min(Math.floor(template.leadDays), 120)
                : 0,
              template.categoryId ? template.categoryId : null,
              typeof template.sourceTemplateId === 'string' && template.sourceTemplateId
                ? template.sourceTemplateId
                : null,
              typeof template.onboardingForClientId === 'string' && template.onboardingForClientId
                ? template.onboardingForClientId
                : null,
              // Skipping is opt-in: anything other than an explicit true is off.
              template.skipAllowed === true,
              template.periodLabelEnabled === true,
              sanitizeCoverageDate(template.periodCoverageStart),
              sanitizeCoverageDate(template.periodCoverageEnd),
              sanitizeCoverageDate(template.periodCoverageAnchorDue),
              createdAtFor('checklist_templates', template.id),
            ],
          )

          // Stages-aware persistence. Migrate flat `items` into a synthetic
          // Stage 1 if the template still carries the legacy shape so writes
          // never lose data.
          const migratedTemplate = ensureTemplateStages(template)
          for (const [stageIdx, stage] of migratedTemplate.stages.entries()) {
            await client.query(
              `
                insert into checklist_template_stages (id, template_id, name, assignee_id, offset_days, due_date, due_day_of_month, position, viewer_ids, editor_ids, updated_at)
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
              `,
              [
                stage.id,
                template.id,
                stage.name,
                stage.assigneeId || null,
                Number(stage.offsetDays) || 0,
                stage.dueDate || null,
                typeof stage.dueDayOfMonth === 'number' && stage.dueDayOfMonth >= 1
                  ? stage.dueDayOfMonth
                  : null,
                stageIdx,
                Array.isArray(stage.viewerIds) ? stage.viewerIds : [],
                Array.isArray(stage.editorIds) ? stage.editorIds : [],
              ],
            )

            for (const [index, item] of (stage.items ?? []).entries()) {
              await client.query(
                `
                  insert into checklist_template_items (id, template_id, label, sort_order, due_date, due_day_of_month, assignee_id, stage_id, sub_items, created_at, updated_at)
                  values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, now())
                `,
                [
                  item.id,
                  template.id,
                  item.label,
                  index,
                  item.dueDate ?? null,
                  typeof item.dueDayOfMonth === 'number' && item.dueDayOfMonth >= 1
                    ? item.dueDayOfMonth
                    : null,
                  item.assigneeId ?? null,
                  stage.id,
                  JSON.stringify(normalizeSubItems(item.subItems, { withDone: false })),
                  createdAtFor('checklist_template_items', item.id),
                ],
              )
            }
          }
        }

        // Re-insert active and recycled checklists in one pass — the bulk
        // wipe above clears the table either way, so we'd lose the recycle
        // bin on every autosave if we only wrote `data.checklists` back.
        // `deletedAt` is the only distinguishing field on the row. We use the
        // pre-filtered safe lists so orphan checklists (whose client was
        // deleted locally) don't wedge the FK insert.
        const checklistsToWrite = [...safeChecklists, ...safeRecycledChecklists]
        for (const checklist of checklistsToWrite) {
          // `on conflict do nothing` is the write-side half of the duplicate
          // backstop. A stale tab that still holds a duplicate instance in
          // memory would otherwise re-upload it here. Two conflicts are
          // possible: the primary key (same id twice in one payload) and the
          // UNIQUE partial index on (template_id, due_date, stage_index).
          // Either way the row is skipped rather than aborting the transaction
          // — an aborted bulk save 500s every read and takes the app offline
          // (the 2026-06-17 incident), which is far worse than dropping a row
          // we already have.
          const insertResult = await client.query(
            `
              insert into checklists (id, title, client_id, assignee_id, template_id, frequency, due_date, viewer_ids, editor_ids, case_id, stage_id, stage_index, stage_count, category_id, deleted_at, deletion_requested_by, deletion_requested_at, onboarding_for_client_id, created_by, skipped_at, skipped_by, period_label, created_at, updated_at)
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, now())
              on conflict do nothing
            `,
            [
              checklist.id,
              checklist.title,
              checklist.clientId,
              checklist.assigneeId,
              checklist.templateId ?? null,
              checklist.frequency ?? null,
              checklist.dueDate,
              Array.isArray(checklist.viewerIds) ? checklist.viewerIds : [],
              Array.isArray(checklist.editorIds) ? checklist.editorIds : [],
              checklist.caseId ?? checklist.id,
              checklist.stageId ?? null,
              typeof checklist.stageIndex === 'number' ? checklist.stageIndex : 0,
              typeof checklist.stageCount === 'number' ? checklist.stageCount : 1,
              checklist.categoryId ? checklist.categoryId : null,
              checklist.deletedAt ?? null,
              checklist.deletionRequestedBy ?? null,
              checklist.deletionRequestedAt ?? null,
              checklist.onboardingForClientId ?? null,
              checklist.createdBy ?? null,
              // A skip must survive the owner's next bulk save. The tab round-
              // trips these two fields untouched (nothing in the UI edits them —
              // POST /api/checklists/:id/skip is the only writer), so persisting
              // them here is what stops an autosave silently un-skipping a task.
              checklist.skippedAt ?? null,
              checklist.skippedBy ?? null,
              // Preserved like the skip stamps above: the bulk save wipes and
              // reinserts, and a column missing here is a label that vanishes on
              // the next autosave with no error anywhere.
              sanitizePeriodLabel(checklist.periodLabel),
              createdAtFor('checklists', checklist.id),
            ],
          )

          // Nothing was inserted ⇒ an identical instance is already in this
          // transaction. Its items MUST be skipped too: `checklist_items`
          // references `checklists(id)`, so inserting them against a row that
          // was never written would blow up the whole save.
          if (insertResult.rowCount === 0) {
            console.warn(
              `[bulk-save] skipped duplicate checklist ${checklist.id} ` +
                `(template ${checklist.templateId ?? 'none'}, due ${checklist.dueDate}, ` +
                `stage ${checklist.stageIndex ?? 0}) — an identical instance is already being written`,
            )
            continue
          }

          for (const [index, payloadItem] of checklist.items.entries()) {
            // What is stored wins for every waiting field on this step and on
            // each of its sub-nodes — a bulk save has no business writing them.
            const item = preservedNodeWaits(payloadItem, priorItemWaits.get(payloadItem.id))
            const subItems = normalizeSubItems(item.subItems, { withDone: true })
            // `done` is derived for items with sub-items (recursing through any
            // sub-sub-items) — persist the roll-up.
            const itemDone =
              subItems.length > 0 ? rollUpItemDone({ ...item, subItems }) : Boolean(item.done)
            await client.query(
              `
                insert into checklist_items (id, checklist_id, label, done, sort_order, due_date, due_day_of_month, assignee_id, waiting_on, waiting, waiting_for_checklist_id, waiting_ons, sub_items, created_at, completed_at, updated_at)
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, now())
              `,
              [
                item.id,
                checklist.id,
                item.label,
                itemDone,
                index,
                item.dueDate ?? null,
                typeof item.dueDayOfMonth === 'number' && item.dueDayOfMonth >= 1
                  ? item.dueDayOfMonth
                  : null,
                item.assigneeId ?? null,
                item.waitingOn ? String(item.waitingOn) : null,
                Boolean(item.waiting),
                item.waitingForChecklistId ? String(item.waitingForChecklistId) : null,
                JSON.stringify(normalizeWaitingOns(item.waitingOns)),
                JSON.stringify(subItems),
                createdAtFor('checklist_items', item.id),
                // The stored stamp wins over anything the payload carries, so a
                // bulk save can neither erase a completion date nor invent one.
                preservedItemCompletion(itemDone, priorItemCompletion.get(item.id)),
              ],
            )
          }
        }

        await client.query('commit')
      } catch (error) {
        await client.query('rollback')
        throw error
      } finally {
        client.release()
      }

      return
    }

    // ---- Store-7: FILE-BACKEND SANITIZE PARITY ----
    //
    // Everything above this line is Postgres-only, and two of the things it
    // does are not Postgres details at all — they are decisions about what a
    // bulk save is allowed to persist:
    //
    //   `filterBulkSaveOrphans`  drops rows whose client / template is not in
    //                            this payload (an in-memory delete that left
    //                            references behind used to wedge every later
    //                            save on an FK violation), and
    //   `sanitizeClientPlanRefs` strips plan references pointing at plans this
    //                            payload does not carry (a dangling one 500-ed
    //                            every read and took the app offline on
    //                            2026-06-17 — `plan_ids` has no FK to catch it).
    //
    // The file branch ran neither, so the dev backend cheerfully persisted the
    // exact shape production strips. That divergence is why the outage could
    // not be reproduced locally. Same sanitizers, same order as the branch
    // above, so what a developer sees on disk is what prod would have kept.
    //
    // Like the Postgres branch this CLEANS, it never refuses: the bulk save is
    // the owner tab's autosave and must not throw.
    const fileValidClientIds = new Set(
      Array.isArray(data.clients) ? data.clients.map((c) => c.id) : [],
    )
    // Filled in after the templates are filtered, so checklists validate their
    // template refs against the post-filter set — same two-step as above.
    const fileValidTemplateIds = new Set()
    const filterFileOrphans = (rows, label, getRefs) =>
      filterBulkSaveOrphans(rows, {
        validClientIds: fileValidClientIds,
        validTemplateIds: fileValidTemplateIds,
        label,
        getRefs,
      })

    // Templates first. Standard templates legitimately have no client — leave
    // those alone (the `? ... : null` is what does it).
    data.checklistTemplates = filterFileOrphans(
      data.checklistTemplates,
      'checklist_templates',
      (t) => ({ clientId: t && t.clientId ? t.clientId : null }),
    )
    for (const t of data.checklistTemplates) fileValidTemplateIds.add(t.id)

    // Only `clientId` is checked on checklists, deliberately — see the long
    // comment on the Postgres side about recycled-bin tombstones. Filtering on
    // `templateId` there silently respawned deleted checklists.
    data.checklists = filterFileOrphans(data.checklists, 'checklists', (c) => ({
      clientId: c?.clientId,
    }))
    data.recycledChecklists = filterFileOrphans(
      data.recycledChecklists,
      'recycledChecklists',
      (c) => ({ clientId: c?.clientId }),
    )
    data.reimbursements = filterFileOrphans(data.reimbursements, 'reimbursements', (r) => ({
      clientId: r?.clientId,
    }))
    data.recurringReimbursements = filterFileOrphans(
      data.recurringReimbursements,
      'recurring_reimbursements',
      (r) => ({ clientId: r?.clientId }),
    )
    // Administrative time carries no client at all (`clientId` null) and is
    // kept: `filterBulkSaveOrphans` only judges refs that are actually set.
    data.timeEntries = filterFileOrphans(data.timeEntries, 'time_entries', (e) => ({
      clientId: e?.clientId,
    }))

    // Plan references, resolved against this payload's plans exactly as the
    // insert above resolves them. Guarded on PRESENCE so a client that never
    // mentioned a plan does not come out of here having grown the fields —
    // same convention `sanitizeAppData` uses for the billing links.
    const fileValidPlanIds = new Set(
      (Array.isArray(data.plans) ? data.plans : [])
        .map((plan) => plan?.id)
        .filter((id) => typeof id === 'string' && id),
    )
    for (const clientRecord of Array.isArray(data.clients) ? data.clients : []) {
      if (!clientRecord || typeof clientRecord !== 'object') continue
      if (!('planIds' in clientRecord) && !('planId' in clientRecord)) continue
      const planRefs = sanitizeClientPlanRefs(clientRecord, fileValidPlanIds)
      clientRecord.planIds = planRefs.planIds
      clientRecord.planId = planRefs.planId
    }

    // Staleness guard, file backend. Same contract as the Postgres branch
    // above: refuse the save outright when the caller's snapshot no longer
    // matches what is on disk. The file equivalent of "the check runs INSIDE
    // the transaction" is running the check, the prior-file preservation reads
    // and the final write in ONE `enqueueFileOperation` slot — as three
    // separate queue entries (the old shape) another writer's op could land
    // between the check and the write and be erased by a snapshot whose check
    // predated it. Raw fs calls only in here: `readJson`/`writeFile` enqueue
    // behind this very slot and would deadlock.
    await enqueueFileOperation(localDataPath, async () => {
      let previous = null
      if (existsSync(localDataPath)) {
        try {
          previous = JSON.parse(await readFile(localDataPath, 'utf8'))
        } catch {
          // A malformed file must not break the guard. An unreadable workspace
          // hashes as empty, which simply means a guarded save sees a mismatch
          // and asks the tab to reload — the safe direction.
          previous = null
        }
      }

      if (expectedVersion) {
        const currentVersion = fileWorkspaceVersion(previous ?? {})
        if (currentVersion !== expectedVersion) {
          throw new StaleWorkspaceError(currentVersion)
        }
      }

      // SECURITY (H4) — file-fallback mirror. In file mode the auth-sensitive
      // fields (the owner/employee `role`, `staffRole`, email and password_hash)
      // live in the SEPARATE auth-state file, which this method never touches —
      // so email and password_hash can't be changed by a bulk save here at all.
      // The one auth-adjacent field carried in app-data is `employees[].role`
      // (the staff-role label). Preserve it the same way the Postgres path does:
      // for any employee id already present in the persisted app-data, keep the
      // prior `role` and let ONLY `name` change. New ids fall through with
      // whatever role the payload carried (real members are created via the
      // invite path; this just stops a bulk save from rewriting an existing
      // member's role). Best-effort: if there's no prior file yet, write as-is.
      try {
        if (previous) {
          const priorRoleById = new Map(
            (Array.isArray(previous.employees) ? previous.employees : [])
              .filter((e) => e && typeof e.id === 'string')
              .map((e) => [e.id, e.role]),
          )
          if (Array.isArray(data.employees)) {
            data.employees = data.employees.map((employee) =>
              employee && priorRoleById.has(employee.id)
                ? { ...employee, role: priorRoleById.get(employee.id) }
                : employee,
            )
          }

          // Cardinal rule 1 mirror of the created_at / completed_at preservation
          // in the Postgres branch. This backend re-writes each record WHOLE, so
          // a payload that dropped `createdAt`, or that carries a stale tab's
          // `completedAt`, rewrites history exactly the way the Postgres wipe did
          // — "it spreads the record" is not by itself protection. Same rule as
          // there: what is already persisted wins; only a step this save actually
          // completes gets a fresh stamp.
          const priorChecklistById = new Map(
            [
              ...(Array.isArray(previous.checklists) ? previous.checklists : []),
              ...(Array.isArray(previous.recycledChecklists) ? previous.recycledChecklists : []),
            ]
              .filter((checklist) => checklist && typeof checklist.id === 'string')
              .map((checklist) => [checklist.id, checklist]),
          )
          const withPreservedHistory = (checklist) => {
            if (!checklist || typeof checklist.id !== 'string') return checklist
            const prior = priorChecklistById.get(checklist.id)
            const priorItemById = new Map(
              (Array.isArray(prior?.items) ? prior.items : [])
                .filter((item) => item && typeof item.id === 'string')
                .map((item) => [item.id, item]),
            )
            const next = { ...checklist }
            if (prior?.createdAt) next.createdAt = prior.createdAt
            if (Array.isArray(checklist.items)) {
              next.items = checklist.items.map((payloadItem) => {
                if (!payloadItem || typeof payloadItem.id !== 'string') return payloadItem
                // Cardinal rule 1 mirror of the Postgres branch: the stored
                // waiting state wins over the payload's, all the way down the
                // sub-item tree. See `preservedNodeWaits`.
                const item = preservedNodeWaits(payloadItem, priorItemById.get(payloadItem.id))
                const done = rollUpItemDone(item)
                const completedAt = preservedItemCompletion(done, priorItemById.get(item.id))
                const merged = { ...item }
                if (completedAt) {
                  merged.completedAt =
                    completedAt instanceof Date ? completedAt.toISOString() : completedAt
                } else {
                  delete merged.completedAt
                }
                return merged
              })
            }
            return next
          }
          if (Array.isArray(data.checklists)) {
            data.checklists = data.checklists.map(withPreservedHistory)
          }
          if (Array.isArray(data.recycledChecklists)) {
            data.recycledChecklists = data.recycledChecklists.map(withPreservedHistory)
          }

          // Cardinal rule 1 mirror of `preservedCoverage` in the Postgres
          // branch: the covered-date ledger, the cycle's anchor day and the
          // pending-resume flag belong to invoice generation and to the confirm
          // control, never to a bulk-save payload.
          //
          // THIS IS ALSO THE OTHER HALF OF THE STALENESS GUARD ABOVE. Those
          // three fields are deliberately EXCLUDED from the fingerprint
          // (`VERSION_IGNORED_FIELDS`), so a month run writing ledgers does not
          // move the version and does not strand every open tab — nor, since
          // d3a386a, does it make `read()`'s materializer write-back refuse
          // itself. What keeps that exclusion safe is exactly this block: the
          // guard covers the fields a tab may write, and this covers the fields
          // it may not. Remove either one and a concurrent month run loses its
          // ledger to the next save.
          const priorRecurringById = new Map(
            (Array.isArray(previous.recurringReimbursements)
              ? previous.recurringReimbursements
              : []
            )
              .filter((entry) => entry && typeof entry.id === 'string')
              .map((entry) => [entry.id, entry]),
          )
          if (Array.isArray(data.recurringReimbursements)) {
            data.recurringReimbursements = data.recurringReimbursements.map((recurring) => {
              if (!recurring || typeof recurring.id !== 'string') return recurring
              const prior = priorRecurringById.get(recurring.id)
              if (!prior) {
                // Genuinely new: the payload is all there is, and the anchor
                // comes from the first window she typed.
                return normalizeRecurringReimbursement({
                  ...recurring,
                  coverageAnchorDay:
                    recurring.coverageAnchorDay ?? anchorDayFromRange(recurring.coverageEnd),
                })
              }
              return normalizeRecurringReimbursement({
                ...recurring,
                coverageAnchorDay: prior.coverageAnchorDay ?? anchorDayFromRange(prior.coverageEnd),
                coverageResumePending: prior.coverageResumePending,
                coverageHistory: prior.coverageHistory,
              })
            })
          }
        }
      } catch {
        // A malformed prior file must never block a legitimate save. Fall
        // through and persist the incoming data unchanged.
      }

      await fsWriteFile(localDataPath, JSON.stringify(data, null, 2))
    })
  }

  /**
   * Fingerprint of everything the bulk save can destroy — the staleness guard
   * for `PUT /api/app-data`. See lib/workspace-version.js for why this is
   * derived from the data rather than a bumped counter, and why it reads
   * PERSISTED state instead of going through `read()` (which materializes and
   * writes back, so it is neither pure nor deterministic).
   *
   * Both backends, per cardinal rule 1. The two produce different values for
   * the same logical workspace; that is fine, since a fingerprint is only ever
   * compared with another from the same backend.
   *
   * @returns {Promise<string>} hex digest of the current persisted workspace.
   */
  async computeWorkspaceVersion() {
    if (this.pool) {
      return postgresWorkspaceVersion(this.pool)
    }

    // File backend: hash the raw persisted file, NOT read()'s materialized
    // output. A missing file is a brand-new workspace — hash the empty shape so
    // the value is still stable and comparable.
    let raw = {}
    if (existsSync(localDataPath)) {
      try {
        raw = await readJson(localDataPath)
      } catch {
        // A malformed file must not break the guard. An unreadable workspace
        // hashes as empty, which simply means the next PUT sees a mismatch and
        // asks the tab to reload — the safe direction.
        raw = {}
      }
    }
    return fileWorkspaceVersion(raw)
  }

  /**
   * Refuse a write aimed at a BILLING MASTER.
   *
   * "KLC Master Client - no data enterered or collected but shows data for the 4
   * combined" (Brittany, featreq-bcee7e31). The app REFUSES rather than
   * allows-and-ignores, because a master that quietly accepted an hour would
   * show it nowhere: it has no Recap of its own beyond the roll-up of its subs,
   * and its invoice is built entirely from their drafts. The hour would simply
   * stop existing, which is the failure mode this codebase has paid for before.
   *
   * Four write paths call this — time entries, checklists, recurring recipes
   * copied onto a client, and recurring reimbursements. Deliberately no wider:
   * a guard on a path nobody uses is a guard nobody maintains.
   *
   * Silent no-op for an absent or unknown client id: those paths have their own
   * answers for that, and this one must not start speaking for them.
   *
   * @throws {BillingMasterError}
   */
  async _refuseBillingMasterWrite(clientId, what) {
    if (typeof clientId !== 'string' || !clientId) return
    let row = null
    if (this.pool) {
      const { rows } = await this.pool.query(
        `select name, is_billing_master from clients where id = $1`,
        [clientId],
      )
      if (rows.length === 0) return
      row = { name: rows[0].name, isBillingMaster: rows[0].is_billing_master === true }
    } else {
      const data = await readJson(localDataPath)
      const stored = (Array.isArray(data.clients) ? data.clients : []).find(
        (client) => client && client.id === clientId,
      )
      if (!stored) return
      row = { name: stored.name, isBillingMaster: stored.isBillingMaster === true }
    }
    if (!row.isBillingMaster) return
    throw new BillingMasterError(
      `${row.name || 'That client'} is a billing master — it holds no ${what} of its own. Use one of its sub clients instead.`,
    )
  }

  /**
   * The same refusal across a LIST of targets — the split paths hand out time to
   * several clients at once, and one master among them must stop the whole
   * thing before any slice is written. Deduplicated, so a split across three
   * clients costs three lookups rather than one per allocation row.
   */
  async _refuseBillingMasterWrites(clientIds, what) {
    const wanted = new Set(
      (Array.isArray(clientIds) ? clientIds : []).filter((id) => typeof id === 'string' && id),
    )
    for (const clientId of wanted) {
      await this._refuseBillingMasterWrite(clientId, what)
    }
  }

  async createTimeEntry(entry) {
    // A master collects nothing. Checked before anything is built, so the
    // refusal is the whole of what happened.
    await this._refuseBillingMasterWrite(entry?.clientId, 'time')
    // The capture method defaults to 'timer'; only an explicit 'manual' entry
    // carries a reason — any non-manual entry drops manualReason entirely.
    const entryMethod = entry.entryMethod === 'manual' ? 'manual' : 'timer'
    const manualReason =
      entryMethod === 'manual' && typeof entry.manualReason === 'string'
        ? entry.manualReason
        : undefined
    // Approval routing (owner request, Jul 2026): a PURE timer capture skips
    // the per-entry daily queue — the weekly-submission / month-lock review
    // covers it as a whole. Anything a person typed still queues 'pending':
    // manual entries, and group-SPLIT allocations (groupId set — the per-client
    // amounts were staff-chosen even though the time was timer-captured). An
    // unsplit group HOLDING entry auto-approves like any capture; its split
    // products queue when created. Later edits re-queue separately
    // (updateTimeEntry flips approved → pending on material changes).
    const autoApproved = entryMethod === 'timer' && !entry.groupId
    const nextEntry = {
      ...entry,
      id: entry.id ?? `time-${randomUUID().slice(0, 8)}`,
      taskId: entry.taskId ?? null,
      // Normalized to a real boolean so the file backend stores what Postgres's
      // `not null default false` column would — the two backends have to read
      // back identically or a flag set in production behaves differently in CI.
      isAdhoc: Boolean(entry.isAdhoc),
      approvalStatus: autoApproved ? 'approved' : 'pending',
      entryMethod,
      manualReason,
      createdAt: entry.createdAt ?? nowIso(),
    }

    if (this.pool) {
      await this.pool.query(
        `
          insert into time_entries (id, user_id, client_id, entry_date, minutes, category, description, billable, task_id, approval_status, entry_method, manual_reason, is_administrative, is_adhoc, started_at, ended_at, sessions, group_id, group_client_ids, group_allocation, task_label, created_at, updated_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19, $20, $21, $22, now())
        `,
        [
          nextEntry.id,
          nextEntry.employeeId,
          // Administrative time has no client — store NULL so the FK and the
          // orphan-cleanup `not in (clients)` check both leave it alone.
          nextEntry.clientId || null,
          nextEntry.date,
          nextEntry.minutes,
          nextEntry.category ?? 'General',
          nextEntry.description,
          nextEntry.billable,
          nextEntry.taskId,
          nextEntry.approvalStatus,
          nextEntry.entryMethod,
          nextEntry.manualReason ?? null,
          Boolean(nextEntry.isAdministrative),
          Boolean(nextEntry.isAdhoc),
          nextEntry.startAt ?? null,
          nextEntry.endAt ?? null,
          JSON.stringify(Array.isArray(nextEntry.sessions) ? nextEntry.sessions : []),
          nextEntry.groupId ? String(nextEntry.groupId) : null,
          Array.isArray(nextEntry.groupClientIds)
            ? nextEntry.groupClientIds.filter((id) => typeof id === 'string' && id)
            : [],
          normalizeGroupAllocation(nextEntry.groupAllocation),
          nextEntry.taskId ? null : nextEntry.taskLabel ? String(nextEntry.taskLabel) : null,
          new Date(nextEntry.createdAt),
        ],
      )

      return nextEntry
    }

    const data = await readJson(localDataPath)
    data.timeEntries = [nextEntry, ...data.timeEntries]
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return nextEntry
  }

  /**
   * ATOMICALLY replace an unsplit group holding entry with one billable slice
   * per client.
   *
   * This used to be a client-side loop: N calls to POST /api/time-entries then
   * a DELETE. Any failure part-way through left BOTH the new slices and the
   * holding entry counting toward the day's totals, and the slices were created
   * from scratch so they carried NO `sessions` — the original clock-in/out was
   * gone for good and the Raw report showed blank in/out for split time.
   *
   * Here the whole thing is one unit of work. Each slice INHERITS the source
   * entry's date, description, capture method + manual reason, task label,
   * category, its `sessions` verbatim and its started_at/ended_at envelope, and
   * the employee. Each slice gets its own client, `isAdministrative: false`,
   * the shared `groupId`, and `groupAllocation` set to the mode that produced
   * it.
   *
   * The source may be an unsplit GROUP holding block (the original case) or a
   * plain client-billed entry — the owner asked to divide ordinary time across
   * clients, and a slice from an earlier split is just another such entry. The
   * two differ only in where the allowed target clients come from (the block's
   * `groupClientIds` vs. the caller's explicit list, validated at the endpoint)
   * and in `billable`: a holding block is parked `billable: false` until split
   * so its slices are forced `true`, while a regular entry already carries the
   * user's own billable choice and keeps it. Administrative time has no client
   * to divide and is refused.
   *
   * Approval status mirrors `createTimeEntry` exactly (`entryMethod === 'timer'
   * && !groupId` auto-approves): a slice always carries a groupId, so it always
   * lands 'pending' in the daily queue — the per-client amounts are typed time,
   * even when the block itself was timer-captured.
   *
   * @param {string} entryId - the entry to split (holding block or regular).
   * @param {Array<{clientId: string, minutes: number}>} allocations
   * @param {string} actorUserId - who performed the split (for the audit row).
   * @param {string} groupId - shared id stamped on every slice.
   * @param {'even'|'full'|'custom'} allocationMode
   * @returns {Promise<{created: object[], deletedId: string}>}
   * @throws {TimeEntrySplitError} when the entry is gone, already split, not
   *   splittable (administrative), or a regular entry got one allocation.
   */
  async splitTimeEntry(entryId, allocations, actorUserId, groupId, allocationMode) {
    const rows = (Array.isArray(allocations) ? allocations : []).filter(
      (row) => row && typeof row.clientId === 'string' && row.clientId && Number(row.minutes) > 0,
    )
    if (rows.length === 0) {
      throw new TimeEntrySplitError('invalid_allocation', 'A split needs at least one allocation.')
    }
    const mode = normalizeGroupAllocation(allocationMode)
    const sharedGroupId = String(groupId || '').slice(0, 64)
    if (!sharedGroupId) {
      throw new TimeEntrySplitError('invalid_allocation', 'A split needs a group id.')
    }
    // A split is a time WRITE onto every client it names, so it is held to the
    // same rule `createTimeEntry` is. Checked before a single slice is built:
    // the endpoint validates that a target exists and is visible, which a
    // billing master both is.
    await this._refuseBillingMasterWrites(rows.map((row) => row.clientId), 'time')

    // The one gate both backends run, so a Postgres-only or file-only rule can
    // never drift. Returns the error to throw, or null when the split may
    // proceed. `not_holding` keeps its original wording: with a client and an
    // administrative entry both handled above, what's left really is a group
    // block someone already split.
    const splitTargetError = (source) => {
      const kind = classifySplitTarget(source)
      if (kind === 'administrative') {
        return new TimeEntrySplitError(
          'not_splittable',
          'Administrative time has no client to split — assign a client first.',
        )
      }
      if (kind === 'unsplittable') {
        return new TimeEntrySplitError(
          'not_holding',
          'That entry is not an unsplit group time block — it may have been split already.',
        )
      }
      if (kind === 'regular' && rows.length < 2) {
        return new TimeEntrySplitError(
          'single_allocation',
          "To move this time to one other client, just edit the entry's client.",
        )
      }
      return null
    }

    // Build every slice from the source entry. Shared by both backends so the
    // two can never disagree on what a slice inherits.
    const buildSlices = (holding) =>
      rows.map((row) => ({
        id: `time-${randomUUID().slice(0, 8)}`,
        employeeId: holding.employeeId,
        clientId: row.clientId,
        isAdministrative: false,
        // Ad hoc travels with the work: dividing one out-of-scope block across
        // three clients makes three pieces of out-of-scope work, not three
        // pieces of scoped work.
        isAdhoc: Boolean(holding.isAdhoc),
        date: holding.date,
        minutes: coerceEntryMinutes(row.minutes),
        category: holding.category ?? 'General',
        description: holding.description ?? '',
        // A group holding block is parked `billable: false` until it is split,
        // so its slices become billable. A regular entry already carries the
        // user's own Billable/Internal choice — dividing it across clients must
        // not silently start billing internal time.
        billable: holding.clientId ? Boolean(holding.billable) : true,
        taskId: null,
        // Typed time → the daily pending queue. See the doc comment above.
        approvalStatus: 'pending',
        entryMethod: holding.entryMethod === 'manual' ? 'manual' : 'timer',
        manualReason: holding.entryMethod === 'manual' ? holding.manualReason : undefined,
        startAt: holding.startAt,
        endAt: holding.endAt,
        // Copied VERBATIM — this is what keeps the original clock-in/out on the
        // Raw report instead of blanking it.
        sessions: Array.isArray(holding.sessions) ? holding.sessions.map((s) => ({ ...s })) : [],
        groupId: sharedGroupId,
        groupClientIds: [],
        groupAllocation: mode,
        ...(holding.taskLabel ? { taskLabel: holding.taskLabel } : {}),
        createdAt: nowIso(),
      }))

    const auditTarget = (holding, slices) => {
      const label = (holding.description || '').trim() || 'Group time'
      const totalMinutes = slices.reduce((sum, slice) => sum + Number(slice.minutes), 0)
      const hours = (totalMinutes / 60).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
      return `${label.slice(0, 120)} · ${slices.length} client${slices.length === 1 ? '' : 's'} · ${hours}h`
    }

    if (this.pool) {
      const client = await this.pool.connect()
      try {
        await client.query('begin')
        // FOR UPDATE: a second, concurrent split of the same block blocks here
        // and then finds the row gone — a clean conflict instead of duplicates.
        const held = await client.query(
          `select id, user_id, client_id, entry_date, minutes, category, description, billable,
                  entry_method, manual_reason, is_administrative, is_adhoc, started_at, ended_at, sessions,
                  group_client_ids, task_label
           from time_entries where id = $1 for update`,
          [entryId],
        )
        if (!held.rowCount) {
          await client.query('rollback')
          throw new TimeEntrySplitError('not_found', 'That time entry no longer exists.')
        }
        const row = held.rows[0]
        const holding = {
          clientId: row.client_id ?? '',
          isAdministrative: Boolean(row.is_administrative),
          isAdhoc: Boolean(row.is_adhoc),
          groupClientIds: Array.isArray(row.group_client_ids)
            ? row.group_client_ids.filter((id) => typeof id === 'string' && id)
            : [],
          billable: row.billable,
          employeeId: row.user_id,
          date: row.entry_date.toISOString().slice(0, 10),
          category: row.category,
          description: row.description,
          entryMethod: row.entry_method === 'manual' ? 'manual' : 'timer',
          manualReason: row.manual_reason ?? undefined,
          startAt: row.started_at ? row.started_at.toISOString() : undefined,
          endAt: row.ended_at ? row.ended_at.toISOString() : undefined,
          sessions: normalizeStoredSessions(row.sessions, row.started_at, row.ended_at),
          taskLabel: row.task_label ?? undefined,
        }
        const targetError = splitTargetError(holding)
        if (targetError) {
          await client.query('rollback')
          throw targetError
        }
        const slices = buildSlices(holding)

        for (const slice of slices) {
          await client.query(
            `insert into time_entries (id, user_id, client_id, entry_date, minutes, category, description,
                                       billable, task_id, approval_status, entry_method, manual_reason,
                                       is_administrative, is_adhoc, started_at, ended_at, sessions, group_id,
                                       group_client_ids, group_allocation, task_label, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19, $20, $21, $22, now())`,
            [
              slice.id,
              slice.employeeId,
              slice.clientId,
              slice.date,
              slice.minutes,
              slice.category,
              slice.description,
              slice.billable,
              slice.taskId,
              slice.approvalStatus,
              slice.entryMethod,
              slice.manualReason ?? null,
              false,
              Boolean(slice.isAdhoc),
              slice.startAt ?? null,
              slice.endAt ?? null,
              JSON.stringify(slice.sessions),
              slice.groupId,
              [],
              slice.groupAllocation,
              slice.taskLabel ?? null,
              new Date(slice.createdAt),
            ],
          )
        }

        await client.query(`delete from time_entries where id = $1`, [entryId])

        // Same table + trim rule as recordActivity, but inside this transaction
        // so the split and its audit row land (or roll back) together.
        await client.query(
          `insert into activity_log (id, user_id, action, target, created_at) values ($1, $2, $3, $4, $5)`,
          [
            `act-${randomUUID().slice(0, 8)}`,
            actorUserId,
            'time_entry_split',
            auditTarget(holding, slices),
            nowIso(),
          ],
        )
        await client.query(
          `delete from activity_log
           where user_id = $1
             and id not in (select id from activity_log where user_id = $1 order by created_at desc limit 200)`,
          [actorUserId],
        )

        await client.query('commit')
        return { created: slices, deletedId: entryId }
      } catch (error) {
        if (!(error instanceof TimeEntrySplitError)) {
          await client.query('rollback').catch(() => {})
        }
        throw error
      } finally {
        client.release()
      }
    }

    // File backend: validate FIRST, then a single mutate + persist, so a bad
    // allocation (or an already-split block) leaves the workspace untouched.
    const data = await readJson(localDataPath)
    const entries = Array.isArray(data.timeEntries) ? data.timeEntries : []
    const holding = entries.find((entry) => entry.id === entryId)
    if (!holding) {
      throw new TimeEntrySplitError('not_found', 'That time entry no longer exists.')
    }
    const targetError = splitTargetError(holding)
    if (targetError) throw targetError
    const slices = buildSlices(holding)
    data.timeEntries = [...slices, ...entries.filter((entry) => entry.id !== entryId)]
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    await this.recordActivity(actorUserId, 'time_entry_split', auditTarget(holding, slices))
    return { created: slices, deletedId: entryId }
  }

  /**
   * Re-divide an EXISTING split: replace every slice of `groupId` with a fresh
   * set built from `allocations`, keeping the same `groupId`.
   *
   * Splitting was one-way — once time was divided, the only way to change the
   * division was to delete the slices and start over, which is what "will not
   * let me adjust my time entry without losing the client split I chose" is
   * describing. This is the way back in: reopen the split with its current
   * distribution and save a different one.
   *
   * The new slices INHERIT the group's invariant fields from the existing ones
   * (they are identical across a group by construction: same user, date,
   * description, category, billable flag, capture method + manual reason, task
   * label, and the source block's `sessions` and start/stop envelope verbatim).
   * What changes is the per-client split: which clients, and how many minutes
   * each. Every slice lands `approval_status: 'pending'` — an adjustment is an
   * edit, and an edit re-enters the daily queue.
   *
   * THE TOTAL MAY CHANGE. Unlike creating a split — which must account for every
   * second of the block it divides — an adjustment is an explicit correction of
   * what was billed, so 60 minutes across three clients may legitimately become
   * 45 across two. `sessions` stay untouched as the audit trail of the clock
   * time that was actually worked.
   *
   * Adjusting DOWN TO ONE client is allowed here, and deliberately asymmetric
   * with `splitTimeEntry`, which refuses a single allocation. Creating a
   * "split" with one client is just re-billing an entry (the edit form's client
   * dropdown), but pulling a client back OUT of an existing split is a real
   * correction — refusing it would leave no way to undo a two-client split
   * short of deleting both slices.
   *
   * @param {string} groupId - the split group to replace.
   * @param {Array<{clientId: string, minutes: number}>} allocations
   * @param {string} actorUserId - who adjusted it (for the audit row).
   * @param {'even'|'full'|'custom'} allocationMode
   * @returns {Promise<{created: object[], deletedIds: string[], groupId: string}>}
   * @throws {TimeEntrySplitError} `invalid_allocation` when nothing usable was
   *   asked for, `not_found` when the group is gone or empty.
   */
  async adjustSplitGroup(groupId, allocations, actorUserId, allocationMode) {
    const sharedGroupId = String(groupId || '').slice(0, 64)
    if (!sharedGroupId) {
      throw new TimeEntrySplitError('invalid_allocation', 'An adjustment needs a group id.')
    }
    const rows = (Array.isArray(allocations) ? allocations : []).filter(
      (row) => row && typeof row.clientId === 'string' && row.clientId && Number(row.minutes) > 0,
    )
    if (rows.length === 0) {
      throw new TimeEntrySplitError(
        'invalid_allocation',
        'An adjustment needs at least one client with time on it.',
      )
    }
    // Re-dividing a group is the same write as making one — same rule.
    await this._refuseBillingMasterWrites(rows.map((row) => row.clientId), 'time')
    const mode = normalizeGroupAllocation(allocationMode)

    // Every field but the client and the minutes comes from the slices already
    // in the group — they all carry the same values, so the first one is the
    // template for the replacements.
    const buildSlices = (template) =>
      rows.map((row) => ({
        id: `time-${randomUUID().slice(0, 8)}`,
        employeeId: template.employeeId,
        clientId: row.clientId,
        isAdministrative: false,
        // Re-dividing the billing does not make out-of-scope work scoped.
        isAdhoc: Boolean(template.isAdhoc),
        date: template.date,
        minutes: coerceEntryMinutes(row.minutes),
        category: template.category ?? 'General',
        description: template.description ?? '',
        billable: Boolean(template.billable),
        taskId: null,
        // An adjustment is an edit: back through approval, like any other.
        approvalStatus: 'pending',
        entryMethod: template.entryMethod === 'manual' ? 'manual' : 'timer',
        manualReason: template.entryMethod === 'manual' ? template.manualReason : undefined,
        startAt: template.startAt,
        endAt: template.endAt,
        // The original clock-in/out, carried across untouched — re-dividing the
        // billing does not rewrite what the timer recorded.
        sessions: Array.isArray(template.sessions) ? template.sessions.map((s) => ({ ...s })) : [],
        groupId: sharedGroupId,
        groupClientIds: [],
        groupAllocation: mode,
        ...(template.taskLabel ? { taskLabel: template.taskLabel } : {}),
        createdAt: nowIso(),
      }))

    const hoursLabel = (minutes) =>
      (minutes / 60).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
    const auditTarget = (template, slices, previousMinutes) => {
      const label = (template.description || '').trim() || 'Group time'
      const nextMinutes = slices.reduce((sum, slice) => sum + Number(slice.minutes), 0)
      return `${label.slice(0, 120)} · ${slices.length} client${
        slices.length === 1 ? '' : 's'
      } · ${hoursLabel(previousMinutes)}h → ${hoursLabel(nextMinutes)}h`
    }

    if (this.pool) {
      const client = await this.pool.connect()
      try {
        await client.query('begin')
        // FOR UPDATE over the whole group: a second adjustment (or a delete of
        // one slice) waits here and then sees the group as this one left it.
        const held = await client.query(
          `select id, user_id, client_id, entry_date, minutes, category, description, billable,
                  entry_method, manual_reason, is_adhoc, started_at, ended_at, sessions, task_label
           from time_entries where group_id = $1 order by created_at, id for update`,
          [sharedGroupId],
        )
        if (!held.rowCount) {
          await client.query('rollback')
          throw new TimeEntrySplitError('not_found', 'That split no longer exists.')
        }
        const row = held.rows[0]
        const template = {
          employeeId: row.user_id,
          date: row.entry_date.toISOString().slice(0, 10),
          minutes: Number(row.minutes),
          category: row.category,
          description: row.description,
          billable: row.billable,
          isAdhoc: Boolean(row.is_adhoc),
          entryMethod: row.entry_method === 'manual' ? 'manual' : 'timer',
          manualReason: row.manual_reason ?? undefined,
          startAt: row.started_at ? row.started_at.toISOString() : undefined,
          endAt: row.ended_at ? row.ended_at.toISOString() : undefined,
          sessions: normalizeStoredSessions(row.sessions, row.started_at, row.ended_at),
          taskLabel: row.task_label ?? undefined,
        }
        const previousMinutes = held.rows.reduce((sum, each) => sum + Number(each.minutes), 0)
        const deletedIds = held.rows.map((each) => each.id)
        const slices = buildSlices(template)

        await client.query(`delete from time_entries where group_id = $1`, [sharedGroupId])

        for (const slice of slices) {
          await client.query(
            `insert into time_entries (id, user_id, client_id, entry_date, minutes, category, description,
                                       billable, task_id, approval_status, entry_method, manual_reason,
                                       is_administrative, is_adhoc, started_at, ended_at, sessions, group_id,
                                       group_client_ids, group_allocation, task_label, created_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18, $19, $20, $21, $22, now())`,
            [
              slice.id,
              slice.employeeId,
              slice.clientId,
              slice.date,
              slice.minutes,
              slice.category,
              slice.description,
              slice.billable,
              slice.taskId,
              slice.approvalStatus,
              slice.entryMethod,
              slice.manualReason ?? null,
              false,
              Boolean(slice.isAdhoc),
              slice.startAt ?? null,
              slice.endAt ?? null,
              JSON.stringify(slice.sessions),
              slice.groupId,
              [],
              slice.groupAllocation,
              slice.taskLabel ?? null,
              new Date(slice.createdAt),
            ],
          )
        }

        // Inside the transaction, same as the split's audit row, so the change
        // and its log entry land (or roll back) together.
        await client.query(
          `insert into activity_log (id, user_id, action, target, created_at) values ($1, $2, $3, $4, $5)`,
          [
            `act-${randomUUID().slice(0, 8)}`,
            actorUserId,
            'time_entry_split_adjusted',
            auditTarget(template, slices, previousMinutes),
            nowIso(),
          ],
        )
        await client.query(
          `delete from activity_log
           where user_id = $1
             and id not in (select id from activity_log where user_id = $1 order by created_at desc limit 200)`,
          [actorUserId],
        )

        await client.query('commit')
        return { created: slices, deletedIds, groupId: sharedGroupId }
      } catch (error) {
        if (!(error instanceof TimeEntrySplitError)) {
          await client.query('rollback').catch(() => {})
        }
        throw error
      } finally {
        client.release()
      }
    }

    // File backend: validate FIRST, then one mutate + persist, so a rejected
    // adjustment leaves the workspace exactly as it was.
    const data = await readJson(localDataPath)
    const entries = Array.isArray(data.timeEntries) ? data.timeEntries : []
    const existing = entries.filter((entry) => entry.groupId === sharedGroupId)
    if (existing.length === 0) {
      throw new TimeEntrySplitError('not_found', 'That split no longer exists.')
    }
    const previousMinutes = existing.reduce((sum, entry) => sum + Number(entry.minutes), 0)
    const deletedIds = existing.map((entry) => entry.id)
    const slices = buildSlices(existing[0])
    data.timeEntries = [
      ...slices,
      ...entries.filter((entry) => entry.groupId !== sharedGroupId),
    ]
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    await this.recordActivity(
      actorUserId,
      'time_entry_split_adjusted',
      auditTarget(existing[0], slices, previousMinutes),
    )
    return { created: slices, deletedIds, groupId: sharedGroupId }
  }

  /**
   * Look up a time entry by id from whichever backend is active.
   * Returns the app-shaped entry (camelCase) or null.
   */
  async getTimeEntry(entryId) {
    if (this.pool) {
      const result = await this.pool.query(
        `select id, user_id, client_id, entry_date, minutes, category, description, billable, task_id,
                approval_status, approval_note, approved_by, approved_at, entry_method, manual_reason,
                is_administrative, is_adhoc, started_at, ended_at, sessions, group_id, group_client_ids,
                group_allocation, task_label, created_at
         from time_entries where id = $1`,
        [entryId],
      )
      if (!result.rowCount) return null
      const row = result.rows[0]
      return {
        id: row.id,
        employeeId: row.user_id,
        clientId: row.client_id ?? '',
        isAdministrative: Boolean(row.is_administrative),
        isAdhoc: Boolean(row.is_adhoc),
        date: row.entry_date.toISOString().slice(0, 10),
        minutes: Number(row.minutes),
        category: row.category,
        description: row.description,
        billable: row.billable,
        taskId: row.task_id ?? null,
        approvalStatus: row.approval_status ?? 'approved',
        approvalNote: row.approval_note ?? undefined,
        approvedBy: row.approved_by ?? undefined,
        approvedAt: row.approved_at ? row.approved_at.toISOString() : undefined,
        entryMethod: row.entry_method === 'manual' ? 'manual' : 'timer',
        manualReason: row.manual_reason ?? undefined,
        startAt: row.started_at ? row.started_at.toISOString() : undefined,
        endAt: row.ended_at ? row.ended_at.toISOString() : undefined,
        sessions: normalizeStoredSessions(row.sessions, row.started_at, row.ended_at),
        groupId: row.group_id ?? undefined,
        groupClientIds: Array.isArray(row.group_client_ids)
          ? row.group_client_ids.filter((id) => typeof id === 'string' && id)
          : [],
        ...(row.group_allocation ? { groupAllocation: row.group_allocation } : {}),
        ...(row.task_label ? { taskLabel: row.task_label } : {}),
        ...(row.created_at ? { createdAt: row.created_at.toISOString() } : {}),
      }
    }

    const data = await readJson(localDataPath)
    return (data.timeEntries ?? []).find((entry) => entry.id === entryId) ?? null
  }

  /**
   * Update mutable fields on a time entry. `patch` may carry minutes,
   * description, billable, taskId, category, and the approval-workflow fields
   * (approvalStatus, approvalNote, approvedBy, approvedAt). Returns the updated
   * app-shaped entry or null when the entry doesn't exist.
   */
  async updateTimeEntry(entryId, patch) {
    // Moving an entry ONTO a billing master is the same write as creating one
    // there, and the hour would vanish just as completely. Above the backend
    // split, so one check covers both — the shape the paid lock uses.
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'clientId')) {
      await this._refuseBillingMasterWrite(patch.clientId, 'time')
    }

    if (this.pool) {
      const setClauses = []
      const params = [entryId]
      const map = {
        employeeId: 'user_id',
        clientId: 'client_id',
        isAdministrative: 'is_administrative',
        isAdhoc: 'is_adhoc',
        minutes: 'minutes',
        description: 'description',
        billable: 'billable',
        taskId: 'task_id',
        category: 'category',
        date: 'entry_date',
        approvalStatus: 'approval_status',
        approvalNote: 'approval_note',
        approvedBy: 'approved_by',
        approvedAt: 'approved_at',
        startAt: 'started_at',
        endAt: 'ended_at',
      }
      for (const [appKey, dbCol] of Object.entries(map)) {
        if (patch && Object.prototype.hasOwnProperty.call(patch, appKey)) {
          const value = coerceTimeEntryPatchValue(appKey, patch[appKey])
          params.push(value)
          setClauses.push(`${dbCol} = $${params.length}`)
        }
      }
      // sessions is jsonb — stringify + cast, separate from the scalar map.
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'sessions')) {
        params.push(JSON.stringify(Array.isArray(patch.sessions) ? patch.sessions : []))
        setClauses.push(`sessions = $${params.length}::jsonb`)
      }
      if (setClauses.length === 0) return this.getTimeEntry(entryId)
      setClauses.push('updated_at = now()')
      const result = await this.pool.query(
        `update time_entries set ${setClauses.join(', ')} where id = $1 returning id`,
        params,
      )
      if (!result.rowCount) return null
      return this.getTimeEntry(entryId)
    }

    const data = await readJson(localDataPath)
    let updated = null
    data.timeEntries = (data.timeEntries ?? []).map((entry) => {
      if (entry.id !== entryId) return entry
      const next = { ...entry }
      for (const key of [
        'employeeId', 'clientId', 'isAdministrative', 'isAdhoc', 'minutes', 'description', 'billable',
        'taskId', 'category', 'date',
        'approvalStatus', 'approvalNote', 'approvedBy', 'approvedAt', 'startAt', 'endAt', 'sessions',
      ]) {
        if (patch && Object.prototype.hasOwnProperty.call(patch, key)) {
          const value = patch[key]
          if ((key === 'approvalNote' || key === 'approvedBy' || key === 'approvedAt') &&
              (value === '' || value === undefined || value === null)) {
            delete next[key]
          } else if (key === 'taskId') {
            next[key] = value || null
          } else {
            next[key] = value
          }
        }
      }
      updated = next
      return next
    })
    if (!updated) return null
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return updated
  }

  async deleteTimeEntry(entryId) {
    if (this.pool) {
      const result = await this.pool.query(
        `delete from time_entries where id = $1 returning id`,
        [entryId],
      )
      return result.rowCount > 0
    }

    const data = await readJson(localDataPath)
    const before = (data.timeEntries ?? []).length
    data.timeEntries = (data.timeEntries ?? []).filter((entry) => entry.id !== entryId)
    if (data.timeEntries.length === before) return false
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return true
  }

  /** Approve a batch of time entries. Returns the count actually updated. */
  async approveTimeEntries(entryIds, approverId) {
    const ids = Array.isArray(entryIds) ? entryIds.filter((id) => typeof id === 'string') : []
    if (ids.length === 0) return 0
    const approvedAt = nowIso()

    if (this.pool) {
      const result = await this.pool.query(
        `update time_entries
         set approval_status = 'approved', approved_by = $2, approved_at = $3,
             approval_note = null, updated_at = now()
         where id = any($1::text[])`,
        [ids, approverId, approvedAt],
      )
      return result.rowCount
    }

    const data = await readJson(localDataPath)
    let count = 0
    const idSet = new Set(ids)
    data.timeEntries = (data.timeEntries ?? []).map((entry) => {
      if (!idSet.has(entry.id)) return entry
      count += 1
      const next = { ...entry, approvalStatus: 'approved', approvedBy: approverId, approvedAt }
      delete next.approvalNote
      return next
    })
    if (count > 0) {
      await writeFile(localDataPath, JSON.stringify(data, null, 2))
    }
    return count
  }

  /** Create a timesheet lock and auto-approve that user's pending entries. */
  async lockTimesheet(userId, period, lockedBy) {
    const lockedAt = nowIso()
    const id = `lock-${randomUUID().slice(0, 8)}`

    if (this.pool) {
      await this.pool.query(
        `insert into timesheet_locks (id, user_id, period, locked_by, locked_at)
         values ($1, $2, $3, $4, $5)
         on conflict (user_id, period) do nothing`,
        [id, userId, period, lockedBy, lockedAt],
      )
      // Locking signs off the month: auto-approve still-pending entries.
      await this.pool.query(
        `update time_entries
         set approval_status = 'approved', approved_by = $3, approved_at = $4, updated_at = now()
         where user_id = $1 and approval_status = 'pending'
           and to_char(entry_date, 'YYYY-MM') = $2`,
        [userId, period, lockedBy, lockedAt],
      )
      const result = await this.pool.query(
        `select id, user_id, period, locked_by, locked_at from timesheet_locks
         where user_id = $1 and period = $2`,
        [userId, period],
      )
      const row = result.rows[0]
      return row
        ? {
            id: row.id,
            userId: row.user_id,
            period: row.period,
            lockedBy: row.locked_by,
            lockedAt: row.locked_at ? row.locked_at.toISOString() : lockedAt,
          }
        : null
    }

    const data = await readJson(localDataPath)
    if (!Array.isArray(data.timesheetLocks)) data.timesheetLocks = []
    let lock = data.timesheetLocks.find((l) => l.userId === userId && l.period === period)
    if (!lock) {
      lock = { id, userId, period, lockedBy, lockedAt }
      data.timesheetLocks.push(lock)
    }
    data.timeEntries = (data.timeEntries ?? []).map((entry) => {
      if (
        entry.employeeId === userId &&
        entry.approvalStatus === 'pending' &&
        typeof entry.date === 'string' &&
        entry.date.slice(0, 7) === period
      ) {
        return { ...entry, approvalStatus: 'approved', approvedBy: lockedBy, approvedAt: lockedAt }
      }
      return entry
    })
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return lock
  }

  /** Remove a timesheet lock. Returns true when a lock was removed. */
  async unlockTimesheet(userId, period) {
    if (this.pool) {
      const result = await this.pool.query(
        `delete from timesheet_locks where user_id = $1 and period = $2 returning id`,
        [userId, period],
      )
      return result.rowCount > 0
    }

    const data = await readJson(localDataPath)
    const before = (data.timesheetLocks ?? []).length
    data.timesheetLocks = (data.timesheetLocks ?? []).filter(
      (l) => !(l.userId === userId && l.period === period),
    )
    if (data.timesheetLocks.length === before) return false
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return true
  }

  /** True when the given user's timesheet is locked for the given 'YYYY-MM'. */
  async isTimesheetLocked(userId, period) {
    if (!userId || !period) return false
    if (this.pool) {
      const result = await this.pool.query(
        `select 1 from timesheet_locks where user_id = $1 and period = $2`,
        [userId, period],
      )
      return result.rowCount > 0
    }
    const data = await readJson(localDataPath)
    return (data.timesheetLocks ?? []).some(
      (l) => l.userId === userId && l.period === period,
    )
  }

  /**
   * Bookkeeper / accountant submits their Sun-Sat week for owner review.
   * Idempotent on the (user, weekStart) pair: a fresh submit creates a
   * row, a re-submit after a rejection upgrades that same row back to
   * 'pending' (clears reviewer fields + note). Re-submitting an already-
   * pending row simply touches `submitted_at` — useful when the
   * bookkeeper edits a previously-pending week and wants the owner to
   * re-look. Approved submissions can't be re-submitted via this path;
   * the owner has to unlock first (rejection path resets the state).
   * Returns the resulting submission row, or null when the user is gone.
   */
  async submitWeeklyTimesheet(userId, weekStart) {
    if (!userId || !weekStart) return null
    const submittedAt = nowIso()
    const id = `wsub-${randomUUID().slice(0, 8)}`

    if (this.pool) {
      const result = await this.pool.query(
        `insert into weekly_submissions
           (id, user_id, week_start, submitted_at, status, reviewed_by, reviewed_at, review_note)
         values ($1, $2, $3, $4, 'pending', null, null, null)
         on conflict (user_id, week_start) do update
           set status = case when weekly_submissions.status = 'approved'
                              then weekly_submissions.status
                              else 'pending' end,
               submitted_at = excluded.submitted_at,
               reviewed_by = case when weekly_submissions.status = 'approved'
                                   then weekly_submissions.reviewed_by
                                   else null end,
               reviewed_at = case when weekly_submissions.status = 'approved'
                                   then weekly_submissions.reviewed_at
                                   else null end,
               review_note = case when weekly_submissions.status = 'approved'
                                   then weekly_submissions.review_note
                                   else null end
         returning id, user_id, week_start, submitted_at, status, reviewed_by, reviewed_at, review_note`,
        [id, userId, weekStart, submittedAt],
      )
      const row = result.rows[0]
      if (!row) return null
      return {
        id: row.id,
        userId: row.user_id,
        weekStart: row.week_start.toISOString().slice(0, 10),
        submittedAt: row.submitted_at ? row.submitted_at.toISOString() : submittedAt,
        status: row.status,
        ...(row.reviewed_by ? { reviewedBy: row.reviewed_by } : {}),
        ...(row.reviewed_at ? { reviewedAt: row.reviewed_at.toISOString() } : {}),
        ...(row.review_note ? { reviewNote: row.review_note } : {}),
      }
    }

    const data = await readJson(localDataPath)
    if (!Array.isArray(data.weeklySubmissions)) data.weeklySubmissions = []
    const existing = data.weeklySubmissions.find(
      (s) => s.userId === userId && s.weekStart === weekStart,
    )
    let resulting
    if (existing) {
      if (existing.status === 'approved') {
        // Already-approved weeks can't be re-submitted; return as-is.
        resulting = existing
      } else {
        existing.status = 'pending'
        existing.submittedAt = submittedAt
        delete existing.reviewedBy
        delete existing.reviewedAt
        delete existing.reviewNote
        resulting = existing
      }
    } else {
      resulting = { id, userId, weekStart, submittedAt, status: 'pending' }
      data.weeklySubmissions.push(resulting)
    }
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return resulting
  }

  /**
   * Owner approves a pending weekly submission. Atomically:
   *  - flips the submission row to status='approved' with reviewer fields
   *  - flips every still-pending time entry in that user's Sun-Sat week
   *    to approval_status='approved' so the per-entry approval queue
   *    drains in step with the weekly sign-off.
   * Returns the updated submission, or null when the id doesn't match.
   */
  async approveWeeklySubmission(submissionId, ownerId) {
    if (!submissionId || !ownerId) return null
    const reviewedAt = nowIso()

    if (this.pool) {
      const client = await this.pool.connect()
      try {
        await client.query('begin')
        const target = await client.query(
          `select id, user_id, week_start
           from weekly_submissions
           where id = $1 and status = 'pending'
           for update`,
          [submissionId],
        )
        if (!target.rowCount) {
          await client.query('rollback')
          return null
        }
        const { user_id: userId, week_start: weekStart } = target.rows[0]

        await client.query(
          `update time_entries
             set approval_status = 'approved',
                 approved_by = $1,
                 approved_at = $2,
                 updated_at = now()
             where user_id = $3
               and approval_status = 'pending'
               and entry_date >= $4
               and entry_date < ($4::date + interval '7 days')`,
          [ownerId, reviewedAt, userId, weekStart],
        )

        const updated = await client.query(
          `update weekly_submissions
             set status = 'approved',
                 reviewed_by = $1,
                 reviewed_at = $2,
                 review_note = null
             where id = $3
             returning id, user_id, week_start, submitted_at, status, reviewed_by, reviewed_at, review_note`,
          [ownerId, reviewedAt, submissionId],
        )
        await client.query('commit')
        const row = updated.rows[0]
        if (!row) return null
        return {
          id: row.id,
          userId: row.user_id,
          weekStart: row.week_start.toISOString().slice(0, 10),
          submittedAt: row.submitted_at ? row.submitted_at.toISOString() : reviewedAt,
          status: row.status,
          reviewedBy: row.reviewed_by,
          reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : reviewedAt,
        }
      } catch (error) {
        await client.query('rollback')
        throw error
      } finally {
        client.release()
      }
    }

    const data = await readJson(localDataPath)
    const submissions = Array.isArray(data.weeklySubmissions) ? data.weeklySubmissions : []
    const target = submissions.find((s) => s.id === submissionId && s.status === 'pending')
    if (!target) return null
    const userId = target.userId
    const weekStart = target.weekStart
    const weekEndDate = new Date(`${weekStart}T12:00:00`)
    weekEndDate.setDate(weekEndDate.getDate() + 7)
    const weekEnd = weekEndDate.toISOString().slice(0, 10)

    data.timeEntries = (data.timeEntries ?? []).map((entry) => {
      if (
        entry.employeeId === userId &&
        entry.approvalStatus === 'pending' &&
        typeof entry.date === 'string' &&
        entry.date >= weekStart &&
        entry.date < weekEnd
      ) {
        return {
          ...entry,
          approvalStatus: 'approved',
          approvedBy: ownerId,
          approvedAt: reviewedAt,
        }
      }
      return entry
    })

    target.status = 'approved'
    target.reviewedBy = ownerId
    target.reviewedAt = reviewedAt
    delete target.reviewNote
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return target
  }

  /**
   * Owner rejects a pending weekly submission with a note. The submission
   * row keeps a history record (status='rejected' with the note); the
   * bookkeeper can edit their entries again and call `submitWeeklyTimesheet`
   * to upgrade the row back to 'pending' for another review pass.
   * Returns the updated submission, or null when the id doesn't match.
   */
  async rejectWeeklySubmission(submissionId, ownerId, note) {
    if (!submissionId || !ownerId) return null
    const reviewedAt = nowIso()
    const trimmedNote = typeof note === 'string' ? note.trim() : ''

    if (this.pool) {
      const result = await this.pool.query(
        `update weekly_submissions
           set status = 'rejected',
               reviewed_by = $1,
               reviewed_at = $2,
               review_note = $3
           where id = $4 and status = 'pending'
           returning id, user_id, week_start, submitted_at, status, reviewed_by, reviewed_at, review_note`,
        [ownerId, reviewedAt, trimmedNote || null, submissionId],
      )
      const row = result.rows[0]
      if (!row) return null
      return {
        id: row.id,
        userId: row.user_id,
        weekStart: row.week_start.toISOString().slice(0, 10),
        submittedAt: row.submitted_at ? row.submitted_at.toISOString() : reviewedAt,
        status: row.status,
        reviewedBy: row.reviewed_by,
        reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : reviewedAt,
        ...(row.review_note ? { reviewNote: row.review_note } : {}),
      }
    }

    const data = await readJson(localDataPath)
    const submissions = Array.isArray(data.weeklySubmissions) ? data.weeklySubmissions : []
    const target = submissions.find((s) => s.id === submissionId && s.status === 'pending')
    if (!target) return null
    target.status = 'rejected'
    target.reviewedBy = ownerId
    target.reviewedAt = reviewedAt
    if (trimmedNote) {
      target.reviewNote = trimmedNote
    } else {
      delete target.reviewNote
    }
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return target
  }

  /**
   * Owner REOPENS an APPROVED weekly submission — the reverse of approve. The
   * submission goes back to 'pending' (re-entering the owner's review queue) and
   * that week's approved time entries are un-sealed back to 'pending', so they
   * can be edited (once the month is unlocked) and re-reviewed. Only acts on an
   * 'approved' submission; returns the updated row, or null when the id doesn't
   * match an approved one.
   */
  async reopenWeeklySubmission(submissionId) {
    if (!submissionId) return null
    const reopenedAt = nowIso()

    if (this.pool) {
      const client = await this.pool.connect()
      try {
        await client.query('begin')
        const target = await client.query(
          `select id, user_id, week_start
             from weekly_submissions
             where id = $1 and status = 'approved'
             for update`,
          [submissionId],
        )
        if (!target.rowCount) {
          await client.query('rollback')
          return null
        }
        const { user_id: userId, week_start: weekStart } = target.rows[0]

        await client.query(
          `update time_entries
             set approval_status = 'pending',
                 approved_by = null,
                 approved_at = null,
                 updated_at = now()
             where user_id = $1
               and approval_status = 'approved'
               and entry_date >= $2
               and entry_date < ($2::date + interval '7 days')`,
          [userId, weekStart],
        )

        const updated = await client.query(
          `update weekly_submissions
             set status = 'pending',
                 reviewed_by = null,
                 reviewed_at = null,
                 review_note = null
             where id = $1
             returning id, user_id, week_start, submitted_at, status, reviewed_by, reviewed_at, review_note`,
          [submissionId],
        )
        await client.query('commit')
        const row = updated.rows[0]
        if (!row) return null
        return {
          id: row.id,
          userId: row.user_id,
          weekStart: row.week_start.toISOString().slice(0, 10),
          submittedAt: row.submitted_at ? row.submitted_at.toISOString() : reopenedAt,
          status: row.status,
          reviewedBy: row.reviewed_by,
          reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : null,
        }
      } catch (error) {
        await client.query('rollback')
        throw error
      } finally {
        client.release()
      }
    }

    const data = await readJson(localDataPath)
    const submissions = Array.isArray(data.weeklySubmissions) ? data.weeklySubmissions : []
    const target = submissions.find((s) => s.id === submissionId && s.status === 'approved')
    if (!target) return null
    const userId = target.userId
    const weekStart = target.weekStart
    const weekEndDate = new Date(`${weekStart}T12:00:00`)
    weekEndDate.setDate(weekEndDate.getDate() + 7)
    const weekEnd = weekEndDate.toISOString().slice(0, 10)

    data.timeEntries = (data.timeEntries ?? []).map((entry) => {
      if (
        entry.employeeId === userId &&
        entry.approvalStatus === 'approved' &&
        typeof entry.date === 'string' &&
        entry.date >= weekStart &&
        entry.date < weekEnd
      ) {
        const next = { ...entry, approvalStatus: 'pending' }
        delete next.approvedBy
        delete next.approvedAt
        return next
      }
      return entry
    })

    target.status = 'pending'
    delete target.reviewedBy
    delete target.reviewedAt
    delete target.reviewNote
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return target
  }

  /**
   * Create a new reimbursement on a client. Validates the inputs (positive
   * amount, non-empty description, ISO date) and returns the persisted
   * record so the caller can drop it straight into local state. Returns
   * null when validation fails or the client doesn't exist.
   */
  async addReimbursement({ clientId, date, description, amount }) {
    if (!clientId || typeof clientId !== 'string') return null
    // Same refusal as `addRecurringReimbursement`: a master's invoice is built
    // entirely from its subs' drafts, so an expense parked here is billed to
    // nobody and shows up nowhere.
    await this._refuseBillingMasterWrite(clientId, 'reimbursed expenses')
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
    const trimmedDescription = typeof description === 'string' ? description.trim() : ''
    if (!trimmedDescription) return null
    const numericAmount = Number(amount)
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) return null
    const id = `reimb-${randomUUID().slice(0, 8)}`
    const record = {
      id,
      clientId,
      date,
      description: trimmedDescription,
      amount: numericAmount,
    }

    if (this.pool) {
      const exists = await this.pool.query(
        `select 1 from clients where id = $1`,
        [clientId],
      )
      if (!exists.rowCount) return null
      await this.pool.query(
        `insert into reimbursements (id, client_id, date, description, amount)
         values ($1, $2, $3, $4, $5)`,
        [id, clientId, date, trimmedDescription, numericAmount],
      )
      return record
    }

    const data = await readJson(localDataPath)
    if (!Array.isArray(data.clients) || !data.clients.some((entry) => entry.id === clientId)) {
      return null
    }
    if (!Array.isArray(data.reimbursements)) data.reimbursements = []
    data.reimbursements.push(record)
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return record
  }

  /**
   * Partial update for a single reimbursement. Only the fields in `patch`
   * are touched; everything else is left as-is. Same validation rules as
   * the create path. Returns the updated record or null on miss / invalid.
   */
  async updateReimbursement(id, patch) {
    if (!id) return null
    const updates = {}
    if (patch.date !== undefined) {
      if (typeof patch.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(patch.date)) return null
      updates.date = patch.date
    }
    if (patch.description !== undefined) {
      const trimmed = typeof patch.description === 'string' ? patch.description.trim() : ''
      if (!trimmed) return null
      updates.description = trimmed
    }
    if (patch.amount !== undefined) {
      const numericAmount = Number(patch.amount)
      if (!Number.isFinite(numericAmount) || numericAmount <= 0) return null
      updates.amount = numericAmount
    }
    if (Object.keys(updates).length === 0) {
      // No-op patch — fetch and return current record so the client can
      // still receive a stable shape.
      if (this.pool) {
        const result = await this.pool.query(
          `select id, client_id, date, description, amount from reimbursements where id = $1`,
          [id],
        )
        if (!result.rowCount) return null
        const row = result.rows[0]
        return {
          id: row.id,
          clientId: row.client_id,
          date: row.date.toISOString().slice(0, 10),
          description: row.description,
          amount: Number(row.amount),
        }
      }
      const data = await readJson(localDataPath)
      return (data.reimbursements ?? []).find((entry) => entry.id === id) ?? null
    }

    if (this.pool) {
      const setClauses = []
      const values = [id]
      if (updates.date !== undefined) {
        values.push(updates.date)
        setClauses.push(`date = $${values.length}`)
      }
      if (updates.description !== undefined) {
        values.push(updates.description)
        setClauses.push(`description = $${values.length}`)
      }
      if (updates.amount !== undefined) {
        values.push(updates.amount)
        setClauses.push(`amount = $${values.length}`)
      }
      setClauses.push('updated_at = now()')
      const result = await this.pool.query(
        `update reimbursements set ${setClauses.join(', ')} where id = $1
         returning id, client_id, date, description, amount`,
        values,
      )
      if (!result.rowCount) return null
      const row = result.rows[0]
      return {
        id: row.id,
        clientId: row.client_id,
        date: row.date.toISOString().slice(0, 10),
        description: row.description,
        amount: Number(row.amount),
      }
    }

    const data = await readJson(localDataPath)
    const target = (data.reimbursements ?? []).find((entry) => entry.id === id)
    if (!target) return null
    Object.assign(target, updates)
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return target
  }

  /**
   * Delete a subscription plan and unlink it from every client.
   *
   * Postgres mode: the `clients.plan_id` FK (`on delete set null`) clears the
   * legacy SCALAR link, but the multi-plan `plan_ids[]` array column has NO
   * foreign key — so we must strip the id from it EXPLICITLY. Failing to do so
   * leaves a dangling reference in `plan_ids[]` that later crashes the bulk
   * write (the scalar plan_id is re-derived from planIds[0]) and takes the app
   * offline — the 2026-06-17 outage. Returns the ids of clients that were
   * unlinked (via either link) so the caller can mirror the change without a
   * full refetch.
   */
  async deletePlan(id) {
    if (!id) return null
    if (this.pool) {
      // Capture every client linked to this plan BEFORE the delete — via the
      // scalar plan_id OR the plan_ids[] array — so the returned id list
      // reflects everything that changed.
      const affected = await this.pool.query(
        `select id from clients where plan_id = $1 or $1 = any(plan_ids)`,
        [id],
      )
      const result = await this.pool.query(
        `delete from subscription_plans where id = $1 returning id`,
        [id],
      )
      if (!result.rowCount) return null
      // The FK cleared the scalar plan_id for us; the array has no FK, so
      // remove the id from every client's plan_ids[] here. No dangling ref left.
      await this.pool.query(
        `update clients
            set plan_ids = array_remove(plan_ids, $1), updated_at = now()
          where $1 = any(plan_ids)`,
        [id],
      )
      return {
        removedPlanId: id,
        unlinkedClientIds: affected.rows.map((row) => row.id),
      }
    }

    const data = await readJson(localDataPath)
    const before = (data.plans ?? []).length
    data.plans = (data.plans ?? []).filter((plan) => plan.id !== id)
    if (data.plans.length === before) return null
    const unlinkedClientIds = []
    data.clients = (data.clients ?? []).map((client) => {
      const onPlanIds = Array.isArray(client.planIds) && client.planIds.includes(id)
      if (client.planId === id || onPlanIds) {
        unlinkedClientIds.push(client.id)
        return {
          ...client,
          planId: client.planId === id ? null : client.planId,
          planIds: Array.isArray(client.planIds)
            ? client.planIds.filter((planId) => planId !== id)
            : [],
        }
      }
      return client
    })
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return { removedPlanId: id, unlinkedClientIds }
  }

  /** Delete one reimbursement. Returns true when a row was removed. */
  async deleteReimbursement(id) {
    if (!id) return false
    if (this.pool) {
      const result = await this.pool.query(
        `delete from reimbursements where id = $1 returning id`,
        [id],
      )
      return (result.rowCount ?? 0) > 0
    }
    const data = await readJson(localDataPath)
    const before = (data.reimbursements ?? []).length
    data.reimbursements = (data.reimbursements ?? []).filter((entry) => entry.id !== id)
    if (data.reimbursements.length === before) return false
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return true
  }

  /**
   * Create a recurring reimbursement on a client. `startDate` is the
   * anchor: the line shows up first on the invoice for THAT month, then
   * monthly / quarterly (every 3 months from the anchor) / annually
   * (same month each year) per `frequency`. Returns the persisted row,
   * or null on validation / unknown-client failure.
   */
  async addRecurringReimbursement({
    clientId,
    description,
    amount,
    frequency,
    startDate,
    ...coverage
  }) {
    if (!clientId || typeof clientId !== 'string') return null
    await this._refuseBillingMasterWrite(clientId, 'reimbursed expenses')
    const trimmedDescription = typeof description === 'string' ? description.trim() : ''
    if (!trimmedDescription) return null
    const numericAmount = Number(amount)
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) return null
    if (frequency !== 'monthly' && frequency !== 'quarterly' && frequency !== 'annually') {
      return null
    }
    if (typeof startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return null
    const checked = sanitizeCoverageInput(coverage)
    if (!checked.ok) return null
    // Turning it on without a first window is the one combination that cannot
    // work: there would be nothing for the wording to name and nothing to
    // advance from. Refused here rather than silently ignored.
    if (checked.values.coverageEnabled && !(checked.values.coverageStart && checked.values.coverageEnd)) {
      return null
    }
    const id = `recur-${randomUUID().slice(0, 8)}`
    const record = {
      id,
      clientId,
      description: trimmedDescription,
      amount: numericAmount,
      frequency,
      startDate,
      coverageEnabled: false,
      coverageTemplate: '',
      coverageStart: null,
      coverageEnd: null,
      coveragePaused: false,
      coverageResumePending: false,
      coverageHistory: {},
      ...checked.values,
    }
    // The day the first window ENDS on is the day the cycle turns. Stored from
    // here on rather than re-derived, so a window she later confirms onto a
    // different day does not snap back to this one.
    record.coverageAnchorDay = anchorDayFromRange(record.coverageEnd)

    if (this.pool) {
      const exists = await this.pool.query(
        `select 1 from clients where id = $1`,
        [clientId],
      )
      if (!exists.rowCount) return null
      await this.pool.query(
        `insert into recurring_reimbursements
           (id, client_id, description, amount, frequency, start_date,
            coverage_enabled, coverage_template, coverage_start, coverage_end,
            coverage_anchor_day, coverage_paused, coverage_resume_pending, coverage_history)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
        [
          id,
          clientId,
          trimmedDescription,
          numericAmount,
          frequency,
          startDate,
          record.coverageEnabled,
          record.coverageTemplate,
          record.coverageStart,
          record.coverageEnd,
          record.coverageAnchorDay,
          record.coveragePaused,
          record.coverageResumePending,
          JSON.stringify(record.coverageHistory),
        ],
      )
      return record
    }

    const data = await readJson(localDataPath)
    if (!Array.isArray(data.clients) || !data.clients.some((entry) => entry.id === clientId)) {
      return null
    }
    if (!Array.isArray(data.recurringReimbursements)) data.recurringReimbursements = []
    data.recurringReimbursements.push(record)
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return record
  }

  /**
   * Partial update for a recurring reimbursement. Same validation as the
   * create path. Returns the updated record, or null on miss / invalid.
   */
  async updateRecurringReimbursement(id, patch) {
    if (!id) return null

    // Read BEFORE deciding. The coverage fields are not independent of each
    // other — an end date has to follow the start it is being merged onto, and
    // "she just un-paused this" is only knowable against the stored row — so
    // this is a read-merge-write rather than the blind SET it used to be.
    const current = await this._readRecurringReimbursement(id)
    if (!current) return null

    const updates = {}
    if (patch.description !== undefined) {
      const trimmed = typeof patch.description === 'string' ? patch.description.trim() : ''
      if (!trimmed) return null
      updates.description = trimmed
    }
    if (patch.amount !== undefined) {
      const numericAmount = Number(patch.amount)
      if (!Number.isFinite(numericAmount) || numericAmount <= 0) return null
      updates.amount = numericAmount
    }
    if (patch.frequency !== undefined) {
      if (
        patch.frequency !== 'monthly' &&
        patch.frequency !== 'quarterly' &&
        patch.frequency !== 'annually'
      ) {
        return null
      }
      updates.frequency = patch.frequency
    }
    if (patch.startDate !== undefined) {
      if (typeof patch.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(patch.startDate)) {
        return null
      }
      updates.startDate = patch.startDate
    }

    const checked = sanitizeCoverageInput(patch, { partial: true })
    if (!checked.ok) return null
    Object.assign(updates, checked.values)

    const merged = { ...current, ...updates }
    if (merged.coverageStart && merged.coverageEnd && merged.coverageEnd <= merged.coverageStart) {
      return null
    }
    if (merged.coverageEnabled && !(merged.coverageStart && merged.coverageEnd)) return null

    // Re-typing the first window in SETUP re-seeds the anchor — she is saying
    // where the cycle stands, and the day she puts the end on is that day. (The
    // confirm control moves the anchor too, but only when she actually shifts
    // the end onto a different day-of-month; see `confirmExpenseCoverage`.)
    if (updates.coverageEnd !== undefined) {
      updates.coverageAnchorDay = anchorDayFromRange(updates.coverageEnd)
    }

    // SWITCHED BACK ON. The owner decided this: an expense that sat out one or
    // more cycles must ask before it bills again, because the months it missed
    // are months the window did not move and nobody can tell from here which
    // window the next invoice should name. The flag is spent by the first
    // generation that sees it — see `_resolveExpenseCoverage`.
    if (current.coveragePaused && merged.coveragePaused === false) {
      updates.coverageResumePending = true
    }

    if (Object.keys(updates).length === 0) return current

    if (this.pool) {
      const columns = {
        description: 'description',
        amount: 'amount',
        frequency: 'frequency',
        startDate: 'start_date',
        coverageEnabled: 'coverage_enabled',
        coverageTemplate: 'coverage_template',
        coverageStart: 'coverage_start',
        coverageEnd: 'coverage_end',
        coverageAnchorDay: 'coverage_anchor_day',
        coveragePaused: 'coverage_paused',
        coverageResumePending: 'coverage_resume_pending',
      }
      const setClauses = []
      const values = [id]
      for (const [key, column] of Object.entries(columns)) {
        if (updates[key] === undefined) continue
        values.push(updates[key])
        setClauses.push(`${column} = $${values.length}`)
      }
      setClauses.push('updated_at = now()')
      const result = await this.pool.query(
        `update recurring_reimbursements set ${setClauses.join(', ')} where id = $1
         returning id, client_id, description, amount, frequency, start_date,
                   coverage_enabled, coverage_template, coverage_start, coverage_end,
                   coverage_anchor_day, coverage_paused, coverage_resume_pending, coverage_history`,
        values,
      )
      if (!result.rowCount) return null
      return mapRecurringReimbursementRow(result.rows[0])
    }

    const data = await readJson(localDataPath)
    const target = (data.recurringReimbursements ?? []).find((entry) => entry.id === id)
    if (!target) return null
    Object.assign(target, updates)
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return target
  }

  /**
   * Run `work` inside one Postgres transaction, or straight through on the file
   * backend — which is single-writer and whose queue already serializes a
   * read-modify-write, so a transaction there would be a no-op wrapper.
   *
   * Same BEGIN / ROLLBACK-on-throw / release-in-finally shape the retainer save
   * and the void pass already use; factored out because three call sites now
   * need it and a hand-rolled fourth is how one of them ends up leaking a
   * connection inside an open transaction.
   */
  async _withTransaction(work) {
    if (!this.pool) return await work(null)
    const dbClient = await this.pool.connect()
    try {
      await dbClient.query('BEGIN')
      const result = await work(dbClient)
      await dbClient.query('COMMIT')
      return result
    } catch (error) {
      try {
        await dbClient.query('ROLLBACK')
      } catch {
        /* already rolled back, or the connection is gone */
      }
      throw error
    } finally {
      dbClient.release()
    }
  }

  /** One recurring reimbursement by id, in app shape, from either backend. */
  async _readRecurringReimbursement(id) {
    if (this.pool) {
      const result = await this.pool.query(
        `select id, client_id, description, amount, frequency, start_date,
                coverage_enabled, coverage_template, coverage_start, coverage_end,
                coverage_anchor_day, coverage_paused, coverage_resume_pending, coverage_history
           from recurring_reimbursements where id = $1`,
        [id],
      )
      if (!result.rowCount) return null
      return mapRecurringReimbursementRow(result.rows[0])
    }
    const data = await readJson(localDataPath)
    const found = (data.recurringReimbursements ?? []).find((entry) => entry.id === id)
    // Through the SAME normalizer the Postgres mapper uses, so a row written
    // before this feature reads identically on both backends. Cardinal rule 1.
    return found ? normalizeRecurringReimbursement(found) : null
  }

  /** Delete one recurring reimbursement. Returns true on success. */
  async deleteRecurringReimbursement(id) {
    if (!id) return false
    if (this.pool) {
      const result = await this.pool.query(
        `delete from recurring_reimbursements where id = $1 returning id`,
        [id],
      )
      return (result.rowCount ?? 0) > 0
    }
    const data = await readJson(localDataPath)
    const before = (data.recurringReimbursements ?? []).length
    data.recurringReimbursements = (data.recurringReimbursements ?? []).filter(
      (entry) => entry.id !== id,
    )
    if (data.recurringReimbursements.length === before) return false
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return true
  }

  /**
   * Record what window an expense was billed for in one period.
   *
   * THE LEDGER IS WRITTEN FROM THE LINE, never recomputed alongside it. The
   * invoice says "this covers July 13 – August 13" and this stores that exact
   * pair, so the document and the thing the next cycle advances from cannot
   * describe different windows. It is also what makes regeneration idempotent:
   * the next run finds the period already answered and hands the same range
   * back rather than stepping again.
   *
   * `coverage_resume_pending` is cleared here because its whole job — make the
   * first invoice after a pause ask — is done the moment that invoice exists.
   */
  async _writeCoverageLedgerEntry(id, period, entry, { dbClient = null, anchorDay = null } = {}) {
    if (!id || !/^\d{4}-\d{2}$/.test(String(period))) return
    const value = {
      start: entry.start,
      end: entry.end,
      needsConfirmation: Boolean(entry.needsConfirmation),
      reason: entry.reason ?? null,
    }
    if (this.pool) {
      // `dbClient` is the caller's OPEN TRANSACTION when there is one. The
      // ledger and the invoice it describes have to land together or not at
      // all: a connection lost between the two would leave an invoice that
      // exists and a cycle that never moved, and the next month would re-bill
      // the same window without asking anybody.
      const runner = dbClient ?? this.pool
      await runner.query(
        `update recurring_reimbursements
            set coverage_history = jsonb_set(
                  coalesce(coverage_history, '{}'::jsonb), array[$2], $3::jsonb, true),
                coverage_resume_pending = false,
                coverage_anchor_day = coalesce($4, coverage_anchor_day),
                updated_at = now()
          where id = $1`,
        [id, period, JSON.stringify(value), anchorDay],
      )
      return
    }
    // The file backend is single-writer and its queue serializes reads against
    // writes, so one read-modify-write IS the atomic unit here.
    const data = await readJson(localDataPath)
    const target = (data.recurringReimbursements ?? []).find((expense) => expense.id === id)
    if (!target) return
    if (!target.coverageHistory || typeof target.coverageHistory !== 'object') {
      target.coverageHistory = {}
    }
    target.coverageHistory[period] = value
    target.coverageResumePending = false
    if (anchorDay !== null) target.coverageAnchorDay = anchorDay
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  }

  /**
   * Forget that a period was ever billed, for every expense on it.
   *
   * VOIDING AN INVOICE UN-BILLS ITS WINDOW. Without this, an August invoice
   * voided and never regenerated leaves 2026-08 sitting in the ledger: September
   * reads it, sees the consecutive period it expects, advances quietly — and the
   * window August was going to cover is never billed to anyone and never
   * mentioned again. Removing the entry puts the expense back where it stood,
   * so a regenerated August resolves to the same window as before (the guarantee
   * is unchanged — the answer is recomputed from the same inputs) and a
   * September generated without one correctly sees the gap and asks.
   */
  async _clearCoverageLedgerForPeriod(period, expenseIds, { dbClient = null } = {}) {
    const ids = [...new Set((expenseIds ?? []).filter(Boolean))]
    if (ids.length === 0 || !/^\d{4}-\d{2}$/.test(String(period))) return
    if (this.pool) {
      const runner = dbClient ?? this.pool
      await runner.query(
        `update recurring_reimbursements
            set coverage_history = coalesce(coverage_history, '{}'::jsonb) - $2,
                updated_at = now()
          where id = any($1::text[])`,
        [ids, period],
      )
      return
    }
    const data = await readJson(localDataPath)
    const wanted = new Set(ids)
    let changed = false
    for (const expense of data.recurringReimbursements ?? []) {
      if (!wanted.has(expense.id)) continue
      if (expense.coverageHistory && period in expense.coverageHistory) {
        delete expense.coverageHistory[period]
        changed = true
      }
    }
    if (changed) await writeFile(localDataPath, JSON.stringify(data, null, 2))
  }

  /**
   * Re-assert `needsCoverageConfirmation` on every recurring line from the
   * AUTHORITATIVE ledger, discarding whatever the caller claimed.
   *
   * The answer lives in `coverage_history[period]` on the expense — that is
   * where confirming writes it and where generation reads it. Anything else is
   * a copy, and a copy that arrives in a request body is not evidence.
   *
   * A line naming an expense that no longer exists, or a period the ledger has
   * no entry for, is left alone: the flag it carries is the only record left,
   * and clearing it would silently open the gate.
   */
  async _deriveCoverageFlags(lineItems, period) {
    const lines = Array.isArray(lineItems) ? lineItems : []
    if (!lines.some((line) => line?.kind === 'recurring' && line?.recurringId)) return lines

    // ONE read for the whole invoice. Per-line reads meant a client with three
    // reimbursed expenses re-read the workspace three times on every save.
    const wanted = [
      ...new Set(
        lines
          .filter((line) => line?.kind === 'recurring' && line?.recurringId)
          .map((line) => line.recurringId),
      ),
    ]
    const resolved = new Map()
    if (this.pool) {
      const { rows } = await this.pool.query(
        `select id, coverage_history from recurring_reimbursements where id = any($1::text[])`,
        [wanted],
      )
      for (const row of rows) {
        resolved.set(row.id, row.coverage_history?.[period] ?? null)
      }
    } else {
      const data = await readJson(localDataPath)
      const byId = new Map(
        (data.recurringReimbursements ?? []).map((expense) => [expense.id, expense]),
      )
      for (const id of wanted) {
        resolved.set(id, byId.get(id)?.coverageHistory?.[period] ?? null)
      }
    }

    return lines.map((line) => {
      if (line?.kind !== 'recurring' || !line.recurringId) return line
      const entry = resolved.get(line.recurringId)
      if (!entry) return line
      const pending = Boolean(entry.needsConfirmation)
      const next = { ...line, needsCoverageConfirmation: pending }
      if (pending) next.coverageReason = entry.reason ?? 'gap'
      else delete next.coverageReason
      if (!pending) delete next.needsCoverageConfirmation
      return next
    })
  }

  /**
   * Does this invoice carry a covered-date window nobody has answered for?
   *
   * Derived from the ledger, not from the invoice's stored lines — the public
   * form of `_deriveCoverageFlags`, for the send route, which has to be able to
   * refuse an invoice that was reviewed before the question was ever asked.
   */
  async invoiceHasUnconfirmedCoverage(invoice) {
    if (!invoice) return false
    const lines = await this._deriveCoverageFlags(invoice.lineItems, invoice.period)
    return hasUnconfirmedCoverage(lines)
  }

  /** Every expense id a set of invoices' recurring lines names. */
  _coveredExpenseIds(invoices) {
    const ids = []
    for (const invoice of invoices ?? []) {
      for (const line of invoice?.lineItems ?? []) {
        if (line?.kind === 'recurring' && line.recurringId) ids.push(line.recurringId)
      }
    }
    return ids
  }

  /**
   * Commit every covered-date window a freshly generated invoice just claimed.
   *
   * Called AFTER the insert lands, so a client who was skipped — or an insert
   * the unique index refused — never moves an expense's window. A window that
   * advanced for an invoice that does not exist is the quiet version of the bug
   * this whole feature is meant to prevent.
   */
  async _commitCoverageForInvoice(period, lineItems, { dbClient = null } = {}) {
    for (const line of Array.isArray(lineItems) ? lineItems : []) {
      if (line?.kind !== 'recurring') continue
      if (!line.recurringId || !isIsoDate(line.coverageStart) || !isIsoDate(line.coverageEnd)) {
        continue
      }
      await this._writeCoverageLedgerEntry(
        line.recurringId,
        period,
        {
          start: line.coverageStart,
          end: line.coverageEnd,
          needsConfirmation: Boolean(line.needsCoverageConfirmation),
          reason: line.coverageReason ?? null,
        },
        { dbClient },
      )
    }
  }

  /**
   * The owner's answer to "confirm the dates this invoice covers".
   *
   * Two things move together and must not come apart: the LINE the client will
   * read, and the LEDGER the next cycle steps from. Confirming an edited window
   * that only landed on the invoice would leave the following month advancing
   * from the range she corrected away from — the exact retyping this feature
   * exists to end, arriving a month later.
   *
   * The wording is re-rendered from her saved template, because the dates are
   * what the template is for; correcting them and leaving the sentence naming
   * the old ones would be worse than not asking at all.
   *
   * Throws `CoverageConfirmationError` for anything it will not accept.
   * Returns the updated invoice, or null when there is no such invoice.
   */
  async confirmExpenseCoverage(invoiceId, recurringId, { start, end } = {}) {
    const all = await this.listInvoices()
    const current = all.find((invoice) => invoice.id === invoiceId)
    if (!current) return null

    // A withdrawn invoice is not a thing to confirm dates on. Writing the ledger
    // for one would advance a cycle on behalf of a document nobody is paying —
    // and voiding is precisely the escape hatch offered to an owner who does not
    // want to answer the question. Same bar as `recordInvoiceSent` and
    // `applyInvoicePayment`, for the same reason.
    if (current.status === 'void') {
      throw new CoverageConfirmationError(
        'This invoice has been voided — generate the month again to bill it.',
      )
    }

    const index = current.lineItems.findIndex(
      (line) => line?.kind === 'recurring' && line?.recurringId === recurringId,
    )
    if (index === -1) {
      throw new CoverageConfirmationError('That expense is not on this invoice.')
    }
    const line = current.lineItems[index]

    // Absent dates mean "the proposed window is right" — she pressed confirm
    // without touching them, which is the common case and must not require the
    // page to echo values back.
    const nextStart = start === undefined ? line.coverageStart : start
    const nextEnd = end === undefined ? line.coverageEnd : end
    if (!isIsoDate(nextStart) || !isIsoDate(nextEnd)) {
      throw new CoverageConfirmationError('Covered dates must look like 2026-08-13.')
    }
    if (nextEnd <= nextStart) {
      throw new CoverageConfirmationError('The end of the covered period must come after its start.')
    }

    const expense = await this._readRecurringReimbursement(recurringId)

    // WHOSE WORDING IS THIS? The template exists to put dates into a sentence,
    // so a confirmed window should refresh that sentence — unless she has since
    // typed her own, in which case rewriting it would throw away an edit she
    // made deliberately ("QBO subscription (per contract)" becoming the template
    // output the moment she pressed Confirm).
    //
    // The test is whether the label still LOOKS generated: it matches what the
    // template would have produced for the window the line is carrying. If it
    // does, she has not touched it and it is ours to update. If it does not, it
    // is hers and it stays. Re-rendering is also skipped outright when the
    // window did not move — there would be nothing new to say.
    const rangeMoved = nextStart !== line.coverageStart || nextEnd !== line.coverageEnd
    const generatedNow = coverageLineLabel(expense, {
      start: line.coverageStart,
      end: line.coverageEnd,
    })
    const untouched = generatedNow !== null && generatedNow === line.label
    const relabeled =
      rangeMoved && untouched
        ? coverageLineLabel(expense, { start: nextStart, end: nextEnd })
        : null

    const lineItems = current.lineItems.map((entry, i) =>
      i === index
        ? {
            ...entry,
            ...(relabeled ? { label: relabeled } : {}),
            coverageStart: nextStart,
            coverageEnd: nextEnd,
            needsCoverageConfirmation: false,
            coverageReason: null,
          }
        : entry,
    )

    // Moving the END onto a different day of the month MOVES THE CYCLE. She has
    // just said this window runs to the 20th; proposing the 13th again next
    // month would bill a 23-day period at the full monthly price and never
    // mention it. Only a genuine change is written — `coalesce` in the ledger
    // write leaves the stored anchor alone when this is null.
    const movedAnchor = anchorDayFromRange(nextEnd)
    const anchorDay =
      rangeMoved && movedAnchor !== null && movedAnchor !== anchorDayOf(expense)
        ? movedAnchor
        : null

    // The line and the ledger land TOGETHER. Confirming is the one moment the
    // two are guaranteed to agree, and a connection lost between them would
    // leave the invoice settled while the cycle it advances still asks.
    const next = { ...current, lineItems, updatedAt: nowIso() }
    await this._withTransaction(async (dbClient) => {
      if (this.pool) {
        await dbClient.query(
          `update invoices set line_items = $2::jsonb, updated_at = now() where id = $1`,
          [invoiceId, JSON.stringify(lineItems)],
        )
      }
      // The ledger gets the CONFIRMED window, so the next cycle steps from what
      // she approved rather than from what was proposed.
      await this._writeCoverageLedgerEntry(
        recurringId,
        current.period,
        { start: nextStart, end: nextEnd, needsConfirmation: false, reason: null },
        { dbClient, anchorDay },
      )
      if (!this.pool) {
        const data = await readJson(localDataPath)
        const stored = (data.invoices ?? []).find((invoice) => invoice.id === invoiceId)
        if (stored) {
          stored.lineItems = lineItems
          stored.updatedAt = next.updatedAt
          await writeFile(localDataPath, JSON.stringify(data, null, 2))
        }
      }
    })
    return next
  }

  /**
   * Idempotently add `userId` to a client's `assignedBookkeeperIds`. Owners
   * are skipped. Returns the (possibly mutated) client record. Best-effort —
   * silent no-op if the client/user can't be found.
   */
  async grantClientVisibility(clientId, userId) {
    if (!clientId || !userId) return null

    if (this.pool) {
      // Skip if user is owner.
      const userResult = await this.pool.query(
        `select role from users where id = $1`,
        [userId],
      )
      if (!userResult.rowCount || userResult.rows[0].role === 'owner') return null

      await this.pool.query(
        `
          update clients
          set assigned_bookkeeper_ids = (
            select coalesce(array_agg(distinct x), '{}')
            from unnest(coalesce(assigned_bookkeeper_ids, '{}')::text[] || array[$2]::text[]) as x
          ),
          updated_at = now()
          where id = $1
        `,
        [clientId, userId],
      )
      return null
    }

    const data = await readJson(localDataPath)
    const employees = Array.isArray(data.employees) ? data.employees : []
    const employee = employees.find((e) => e.id === userId)
    if (!employee || employee.role === 'Owner') return null

    let mutated = false
    data.clients = (data.clients ?? []).map((client) => {
      if (client.id !== clientId) return client
      const ids = Array.isArray(client.assignedBookkeeperIds) ? client.assignedBookkeeperIds : []
      if (ids.includes(userId)) return client
      mutated = true
      return { ...client, assignedBookkeeperIds: [...ids, userId] }
    })
    if (mutated) {
      await writeFile(localDataPath, JSON.stringify(data, null, 2))
    }
    return null
  }

  /**
   * Owner-only: replace the assigned-team list for a client. Filters unknown
   * ids, but not owners — an owner on the list is a display fact, not a
   * grant. Returns the updated client or null.
   */
  async setClientAssignedTeam(clientId, bookkeeperIds) {
    if (this.pool) {
      // Every real user is pickable, owners included. An owner on the list is
      // a display fact: they see every client either way, and hiding them made
      // the Clients-page team column misreport who works the account.
      const usersResult = await this.pool.query(`select id from users`)
      const valid = new Set(usersResult.rows.map((r) => r.id))
      const safe = [...new Set((bookkeeperIds ?? []).filter((id) => valid.has(id)))]
      const result = await this.pool.query(
        `update clients set assigned_bookkeeper_ids = $2, updated_at = now()
         where id = $1
         returning id`,
        [clientId, safe],
      )
      if (!result.rowCount) return null
      const data = await this.read()
      return data.clients.find((client) => client.id === clientId) ?? null
    }

    const data = await readJson(localDataPath)
    const employees = Array.isArray(data.employees) ? data.employees : []
    const valid = new Set(employees.map((e) => e.id))
    const safe = [...new Set((bookkeeperIds ?? []).filter((id) => valid.has(id)))]
    let updated = null
    data.clients = (data.clients ?? []).map((client) => {
      if (client.id !== clientId) return client
      updated = { ...client, assignedBookkeeperIds: safe }
      return updated
    })
    if (!updated) return null
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return updated
  }

  /**
   * Create ONE client, durably, right now.
   *
   * Client creation used to be a local-only workspace mutation that reached the
   * database only when the debounced bulk save ran. That left a window — and if
   * the save was overwritten by another tab, a permanent hole — in which the
   * client existed on screen but not in the database. Everything targeted that
   * referenced it then failed: logging time against it raised a raw foreign-key
   * error, assigning a team to it wrote nothing, and staff sessions could not
   * see it. That is the "I added a client and it never appeared" report, and it
   * is exactly what cardinal rule 4 says to avoid.
   *
   * Mirrors the shape `write()` uses for clients so the two agree.
   *
   * EVERY column the bulk save writes is written here too. The first version of
   * this endpoint persisted twelve of them, so a client created through the Add
   * form came back missing its monthly/annual rate, its estimated role hours,
   * its invoice preferences and its whole team — the fields were entered, the
   * insert simply had no columns for them. Any column added to `write()`'s
   * clients insert must be added here as well.
   */

  /**
   * Every invoice for a period (or all of them), newest client first. Invoices
   * live OUTSIDE the bulk-save payload deliberately — they are money, and a
   * stale owner tab must never be able to rewrite them — so they are read
   * through here rather than off `read()`.
   */
  async listInvoices({ period = null } = {}) {
    if (this.pool) {
      const { rows } = await this.pool.query(
        `select ${INVOICE_SELECT_COLUMNS}
           from invoices
          ${period ? 'where period = $1' : ''}
          order by number nulls last, created_at`,
        period ? [period] : [],
      )
      return rows.map(mapInvoiceRow)
    }
    const data = await readJson(localDataPath)
    const all = Array.isArray(data.invoices) ? data.invoices : []
    return all
      .filter((invoice) => !period || invoice.period === period)
      // Postgres answers `kind` 'monthly' and `applied_to_invoice_id` null for
      // every row written before those columns existed. The file backend has to
      // say the same thing, or a test passes on a shape production never
      // produces (cardinal rule 1 — this is exactly how `email_log` got away).
      .map((invoice) => ({
        ...invoice,
        kind: invoice.kind ?? 'monthly',
        appliedToInvoiceId: invoice.appliedToInvoiceId ?? null,
        // Null, never `[]` — the same distinction `mapInvoiceRow` draws.
        originalLineItems: Array.isArray(invoice.originalLineItems)
          ? invoice.originalLineItems
          : null,
      }))
      .sort((a, b) => String(a.number ?? '').localeCompare(String(b.number ?? '')))
  }

  /**
   * The master invoices a SUB's work appears on — that sub's billing history.
   *
   * A sub gets no invoice of its own, so its client page would otherwise show
   * an empty month and read as "we forgot to bill them" (plan §1). This answers
   * with the document that DID bill it: the master's invoice, its number and
   * status, and the slice of it that is this client's.
   *
   * The subtotal is DERIVED — the sum of the lines carrying this client's
   * `sourceClientId` — never a second money record. One payment lands on one
   * invoice, so a company is paid when the invoice is; there is no partial
   * apportionment because the rail only ever takes an invoice in full.
   *
   * Both backends, and the summing itself is shared between them so the two
   * cannot answer different numbers. Postgres narrows with a jsonb containment
   * match rather than reading every invoice back.
   *
   * @param {string} clientId - the SUB.
   * @param {{period?: string|null}} [options]
   */
  async listBilledOnInvoices(clientId, { period = null } = {}) {
    if (typeof clientId !== 'string' || !clientId) return []

    const summarize = (invoice, masterClientName) => {
      // A VOIDED invoice billed nobody. It stays in the master's own History as
      // the withdrawal it is, but on a sub's page it would read as money owed.
      if (invoice.status === 'void') return null
      const lines = (invoice.lineItems ?? []).filter((line) => line?.sourceClientId === clientId)
      if (lines.length === 0) return null
      return {
        invoiceId: invoice.id,
        number: invoice.number,
        period: invoice.period,
        status: invoice.status,
        masterClientId: invoice.clientId,
        masterClientName: masterClientName ?? null,
        subtotal: roundMoney(lines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0)),
        paidAt: invoice.paidAt ?? null,
      }
    }

    if (this.pool) {
      const params = [JSON.stringify([{ sourceClientId: clientId }])]
      if (period) params.push(period)
      const { rows } = await this.pool.query(
        `select ${INVOICE_SELECT_COLUMNS},
                (select c.name from clients c where c.id = i.client_id) as master_client_name
           from invoices i
          where i.line_items @> $1::jsonb
            and i.status <> 'void'
            ${period ? 'and i.period = $2' : ''}
          order by i.number nulls last, i.created_at`,
        params,
      )
      return rows
        .map((row) => summarize(mapInvoiceRow(row), row.master_client_name ?? null))
        .filter(Boolean)
    }

    const data = await readJson(localDataPath)
    const nameById = new Map(
      (Array.isArray(data.clients) ? data.clients : []).map((entry) => [entry?.id, entry?.name]),
    )
    return (await this.listInvoices({ period }))
      .map((invoice) => summarize(invoice, nameById.get(invoice.clientId) ?? null))
      .filter(Boolean)
  }

  /**
   * Generate the month's drafts — one per client, idempotently.
   *
   * Re-running is safe and is expected: Brittany will run it, log a missed
   * hour, and run it again. A client that already has a live (non-void)
   * invoice for the period is SKIPPED rather than rewritten, because a draft
   * she has already edited must not be silently reverted by a second run.
   * Regenerating one deliberately means voiding it first.
   *
   * Clients with nothing to bill produce no invoice at all — an hourly client
   * with no time this month should not get a $0 document.
   *
   * `clientId` narrows the run to ONE client, which is how the per-client
   * "Email invoice" button builds a missing invoice without touching anyone
   * else's month. The shape of the answer is unchanged — `created` and
   * `skipped` simply end up at most one entry long. In that mode the reasons a
   * client produces nothing are reported rather than passed over in silence:
   * on a month-wide run "no invoice appeared for a prospect" is expected, but
   * someone who asked for one specific client deserves to be told why.
   */
  async generateInvoicesForPeriod(period, { defaultNetDays = 30, clientId = null } = {}) {
    const data = await this.read()
    const existing = await this.listInvoices({ period })
    // MONTHLY only. A retainer issued this month is not the month's invoice, and
    // counting it here would tell the run that a client who signed in August has
    // already been billed for August.
    const liveClientIds = new Set(
      existing
        .filter((invoice) => invoice.kind === 'monthly' && invoice.status !== 'void')
        .map((invoice) => invoice.clientId),
    )
    const takenNumbers = existing.map((invoice) => invoice.number).filter(Boolean)

    // Last month's invoices, for the prior-month true-up. Voids are excluded
    // for the same reason `liveClientIds` excludes them: a voided invoice was
    // withdrawn, so truing up against what it said would carry forward an
    // amount nobody was ever asked to pay.
    // Monthly only, for the same reason as `liveClientIds` plus one of its own:
    // this is a Map keyed by client, so a retainer sharing last month with a
    // real invoice would overwrite it and quietly drop that client's true-up.
    const priorByClient = new Map(
      (await this.listInvoices({ period: previousPeriod(period) }))
        .filter((invoice) => invoice.kind === 'monthly' && invoice.status !== 'void')
        .map((invoice) => [invoice.clientId, invoice]),
    )

    // Who bills to whom, resolved once for the whole run. Each master's subs
    // are held in CLIENT-NAME order so the merged document reads the same way
    // every month rather than in whatever order the roster came back in.
    const subsByMaster = new Map()
    for (const entry of data.clients ?? []) {
      const target = entry?.billToClientId
      if (typeof target !== 'string' || !target) continue
      if (!subsByMaster.has(target)) subsByMaster.set(target, [])
      subsByMaster.get(target).push(entry)
    }
    for (const subs of subsByMaster.values()) {
      subs.sort((left, right) => String(left.name ?? '').localeCompare(String(right.name ?? '')))
    }

    const created = []
    const skipped = []
    const scoped = clientId
      ? (data.clients ?? []).filter((client) => client.id === clientId)
      : (data.clients ?? [])
    if (clientId && scoped.length === 0) {
      return { period, created, skipped: [{ clientId, reason: 'no-such-client' }] }
    }
    for (const client of scoped) {
      // "Already has one" is checked FIRST because it is the more useful answer
      // when both are true: a client who was invoiced and has since been moved
      // back to prospect still has that invoice, and being told they are not
      // billable yet would send someone looking for a document that exists.
      if (liveClientIds.has(client.id)) {
        skipped.push({ clientId: client.id, reason: 'already-generated' })
        continue
      }
      // A retired client generates no new drafts. Reported separately from
      // 'not-billable-yet' because the two are opposite ends of the lifecycle
      // and the fix differs: a prospect is waiting to start, a retired client
      // has finished. Their existing invoices are untouched and stay in
      // History — the `liveClientIds` check above already protects those.
      if (isInactiveClientStage(client.lifecycleStage)) {
        if (clientId) skipped.push({ clientId: client.id, reason: 'client-inactive' })
        continue
      }
      // Prospects and onboarding clients are not billed yet.
      if ((client.lifecycleStage ?? 'active') !== 'active') {
        if (clientId) skipped.push({ clientId: client.id, reason: 'not-billable-yet' })
        continue
      }

      // A SUB's work is billed on its master's invoice, so it gets none of its
      // own — and this is REPORTED, on a month-wide run as well as a single
      // one. The never-generates detector reads these reasons: "billed on KLC
      // Master's invoice" is a real answer, where silence would have it name
      // three companies as unbilled every month forever (plan §1). The master's
      // id rides along so nothing downstream has to re-derive the link.
      //
      // BELOW the lifecycle checks deliberately. A RETIRED sub is on no
      // invoice at all — the merge leaves it out for exactly the same reason
      // this loop does — so claiming it was "billed on the master's invoice"
      // would be a false answer, and a confident one.
      if (typeof client.billToClientId === 'string' && client.billToClientId) {
        skipped.push({
          clientId: client.id,
          reason: 'billed-to-other',
          billedToClientId: client.billToClientId,
        })
        continue
      }

      // One client's inputs, gathered identically whether the result becomes
      // its own invoice or a section of its master's. AD HOC time rides the
      // merge like every other line: a sub no longer gets a monthly invoice of
      // its own, so leaving its ad hoc work behind would bill it ZERO times
      // rather than exactly once (plan §0, corrected while building). Its
      // billed/courtesy/omitted control travels with the line to the master's
      // editor. RETAINERS are untouched here — they stay per-sub
      // engagement-level documents in v1.
      const draftFor = (target, prior) =>
        buildInvoiceDraft({
          client: target,
          period,
          entries: data.timeEntries ?? [],
          plans: data.plans ?? [],
          reimbursements: data.reimbursements ?? [],
          // Normalized through the shared definition, exactly as the Postgres
          // mapper does — the resolver must not see `coverageHistory: undefined`
          // on one backend and `{}` on the other.
          recurringReimbursements: (data.recurringReimbursements ?? []).map(
            normalizeRecurringReimbursement,
          ),
          employees: data.employees ?? [],
          defaultHourlyRate: Number(target.hourlyRate) || 0,
          priorInvoice: prior ?? null,
          defaultNetDays,
        })

      let draft
      if (client.isBillingMaster === true) {
        const subs = subsByMaster.get(client.id) ?? []
        // A master nobody points at can never produce anything, ever. Its own
        // reason, because that is a MISCONFIGURATION someone has to fix —
        // 'nothing-to-bill' would read as a quiet month and be waited out.
        if (subs.length === 0) {
          skipped.push({ clientId: client.id, reason: 'master-without-subs' })
          continue
        }
        // The same lifecycle rule every other client in this loop is held to. A
        // retired sub stops being billed, and must not start again merely
        // because somebody else pays for it.
        const eligibleSubs = []
        for (const sub of subs) {
          if (
            isInactiveClientStage(sub.lifecycleStage) ||
            (sub.lifecycleStage ?? 'active') !== 'active'
          ) {
            continue
          }
          // THE MIGRATION MONTH. 2026-08 was billed per-company before the
          // master row existed, and those invoices are deliberately left alone
          // (plan §0). Merging a sub that still holds a LIVE invoice for this
          // period would issue a second payable document for the same work and
          // re-advance its covered-date window against it — the double-bill this
          // whole feature exists to prevent, arriving on its first run.
          //
          // Said out loud rather than passed over. The sub's own iteration says
          // 'already-generated' (a fact about the sub); this says why it is
          // missing from the master's invoice (a fact about the merge). Two
          // different questions, so two rows.
          if (liveClientIds.has(sub.id)) {
            skipped.push({ clientId: sub.id, reason: 'already-billed-on-own-invoice' })
            continue
          }
          eligibleSubs.push(sub)
        }
        const subDrafts = eligibleSubs
          // The sub's OWN prior invoice, not the master's. A true-up Brittany
          // made on a sub's last per-company invoice is real money that has to
          // land somewhere, and after the migration the only invoice it can land
          // on is the master's. `buildConsolidatedInvoiceDraft` keeps the line
          // as that sub's and raises its `sub-adjustment` flag, which is how
          // she is told a pre-migration correction carried across.
          .map((sub) => ({ client: sub, draft: draftFor(sub, priorByClient.get(sub.id) ?? null) }))
          .filter((entry) => entry.draft.lineItems.length > 0)
        // Assembly — the lines, their `sourceClientId`, the aggregated scope
        // flags and the due date — belongs to lib/invoice-draft.js, which owns
        // every other money shape in this app. The prior-month true-up is the
        // MASTER's own invoice, unchanged: the subs' drafts are built with none.
        draft = buildConsolidatedInvoiceDraft({
          master: client,
          period,
          defaultNetDays,
          subDrafts,
          priorInvoice: priorByClient.get(client.id) ?? null,
        })
      } else {
        draft = draftFor(client, priorByClient.get(client.id) ?? null)
      }
      if (draft.lineItems.length === 0) {
        skipped.push({ clientId: client.id, reason: 'nothing-to-bill' })
        continue
      }

      const number = nextInvoiceNumber(period, takenNumbers)
      takenNumbers.push(number)
      const record = {
        id: `inv-${randomUUID().slice(0, 8)}`,
        clientId: client.id,
        period,
        number,
        kind: 'monthly',
        status: 'draft',
        lineItems: draft.lineItems,
        // What the generator produced, kept beside what it becomes. Every edit
        // Brittany makes from here is measured against this.
        originalLineItems: draft.lineItems,
        subtotal: draft.subtotal,
        total: draft.total,
        dueDate: draft.dueDate,
        blurb: '',
        scopeFlags: draft.scopeFlags,
        sentAt: null,
        paidAt: null,
        paymentMethod: null,
        appliedToInvoiceId: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      // The invoice and the covered-date windows it claims are ONE write. A
      // connection lost between them would leave an invoice on file whose
      // expense never advanced, and the next month would re-bill the same
      // window silently — the exact failure this feature exists to prevent,
      // arriving through the back door.
      const saved = await this._withTransaction(async (dbClient) => {
        const inserted = await this._insertInvoice(record, { dbClient })
        // A null return means the partial unique index refused it — another run
        // created this client's invoice between our read and our write. That is
        // the index doing its job, not an error, and nothing may advance.
        if (inserted) {
          await this._commitCoverageForInvoice(period, inserted.lineItems, { dbClient })
        }
        return inserted
      })
      if (saved) created.push(saved)
      else skipped.push({ clientId: client.id, reason: 'already-generated' })
    }

    return { period, created, skipped }
  }

  /**
   * Issue a RETAINER invoice for one client — the front end of an engagement.
   *
   * Deliberately a manual act. There is no engagement-signing event in this app,
   * so nothing here can know the letter came back signed; the owner does, and
   * she presses the button. That is the whole trigger, and it is why this is not
   * wired into the month run.
   *
   * What comes out is an ordinary DRAFT invoice with `kind: 'retainer'` and one
   * line. From there it lives on the existing rails without a special case:
   * edited in the month-run editor, reviewed, sent, paid, printed, exported.
   * `period` is the month it was issued in — bookkeeping, not a billing window;
   * the kind-scoped unique index is what lets it share that month with the
   * client's real invoice.
   *
   * Returns the invoice, or null when the client does not exist. `amount` must
   * be a positive number — a $0 retainer is a document nobody asked for, and a
   * negative one is a credit note this app has no concept of.
   */
  async createRetainerInvoice({ clientId, amount, note = '', period = null, defaultNetDays = 30 }) {
    const value = roundMoney(amount)
    if (!Number.isFinite(value) || value <= 0) return null

    const data = await this.read()
    const client = (data.clients ?? []).find((entry) => entry.id === clientId)
    if (!client) return null

    const today = nowIso().slice(0, 10)
    const issuedPeriod = /^\d{4}-\d{2}$/.test(String(period ?? '')) ? period : today.slice(0, 7)
    const year = issuedPeriod.slice(0, 4)

    // Year-scoped counter, derived from the retainers that already exist —
    // same idiom as the monthly numbering, and it reads across the whole
    // archive rather than one month's list because that is the scope of the
    // sequence.
    const takenNumbers = (await this.listInvoices())
      .filter((invoice) => invoice.kind === 'retainer')
      .map((invoice) => invoice.number)
      .filter(Boolean)

    const detail = String(note ?? '').trim().slice(0, 300)
    const record = {
      id: `inv-${randomUUID().slice(0, 8)}`,
      clientId: client.id,
      period: issuedPeriod,
      number: nextRetainerInvoiceNumber(year, takenNumbers),
      kind: 'retainer',
      status: 'draft',
      lineItems: [{ kind: 'retainer', label: RETAINER_LABEL, detail, amount: value }],
      // The one line as issued. A retainer is rated by nobody (see the plan
      // doc), but the snapshot costs nothing and keeps every invoice row
      // answering the same question.
      originalLineItems: [{ kind: 'retainer', label: RETAINER_LABEL, detail, amount: value }],
      subtotal: value,
      total: value,
      // From TODAY, not from the end of the month. A retainer is due on the
      // client's terms from the day it is issued; a monthly invoice's clock
      // starts at the end of the period it bills for, and borrowing that here
      // would date the retainer to a month that has not happened yet.
      dueDate: dueDateFromTerms(today, client.paymentTerms, defaultNetDays),
      blurb: '',
      scopeFlags: [],
      sentAt: null,
      paidAt: null,
      paymentMethod: null,
      appliedToInvoiceId: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }

    return await this._insertInvoice(record)
  }

  /**
   * Every retainer that has been PAID and not yet given back — the money this
   * firm is holding on account, client by client.
   *
   * Paid is the bar on purpose: a retainer that was only sent is a promise, and
   * crediting a client for money that never arrived would be giving away work.
   * The UI uses this to decide whether to offer the credit at all; the SAVE does
   * not trust it (see `updateInvoice`), because the answer can go stale between
   * the page loading and the owner pressing Save.
   */
  async listUnappliedRetainers() {
    return (await this.listInvoices()).filter(
      (invoice) =>
        invoice.kind === 'retainer' &&
        invoice.status === 'paid' &&
        !invoice.appliedToInvoiceId,
    )
  }

  /**
   * Void every UNSENT invoice in a period — the voiding half of "Void &
   * regenerate", which refreshes a whole month that was built mid-month and has
   * since gone stale.
   *
   * Only `draft` and `reviewed` are touched, and only in this period. Anything
   * that has left the building — `sent`, `processing`, `paid`, `overdue` — is
   * the client's copy of a promise and must never be rewritten behind their
   * back; an already-`void` row has nothing left to void. The partial unique
   * index allows any number of voids per (client, period), so the generation
   * pass that follows is free to insert a fresh live invoice for each one.
   *
   * Voiding is deliberately destructive to edits: the whole point is to throw
   * away a stale snapshot, so the lines, the note to the client and the review
   * status of the voided invoices are gone. The caller warns about that first.
   *
   * A voided invoice holds no retainer, so any retainer marked against one of
   * these goes back on account in the SAME transaction. Regenerating a month is
   * the likeliest way to void a credited invoice, and leaving the retainer spent
   * on a withdrawn document would strand it: not on account, not credited to
   * anyone, and invisible because nobody works a voided invoice.
   */
  async voidUnsentInvoicesForPeriod(period) {
    // Which expenses these invoices had claimed windows for, read BEFORE the
    // void — the lines survive the status change, but reading first keeps the
    // release scoped to exactly the invoices this pass touches.
    const releasing = this._coveredExpenseIds(
      (await this.listInvoices({ period })).filter(
        (invoice) =>
          (invoice.kind ?? 'monthly') === 'monthly' &&
          (invoice.status === 'draft' || invoice.status === 'reviewed'),
      ),
    )

    if (this.pool) {
      const dbClient = await this.pool.connect()
      try {
        await dbClient.query('BEGIN')
        const { rows } = await dbClient.query(
          `update invoices
              set status = 'void', updated_at = now()
            where period = $1 and kind = 'monthly' and status in ('draft', 'reviewed')
          returning id`,
          [period],
        )
        const ids = rows.map((row) => row.id)
        if (ids.length > 0) {
          await dbClient.query(
            `update invoices
                set applied_to_invoice_id = null, updated_at = now()
              where applied_to_invoice_id = any($1::text[])`,
            [ids],
          )
          // Voiding un-bills the month's covered windows. Regenerating then
          // resolves each one from the same inputs as before and lands on the
          // same range — the idempotency promise is unchanged — while a month
          // voided and LEFT voided correctly reads as unbilled next time.
          await this._clearCoverageLedgerForPeriod(period, releasing, { dbClient })
        }
        await dbClient.query('COMMIT')
        return { voided: ids.length, ids }
      } catch (error) {
        try {
          await dbClient.query('ROLLBACK')
        } catch {
          /* already rolled back, or the connection is gone */
        }
        throw error
      } finally {
        dbClient.release()
      }
    }

    const data = await readJson(localDataPath)
    if (!Array.isArray(data.invoices)) data.invoices = []
    const ids = []
    for (const invoice of data.invoices) {
      if (invoice.period !== period) continue
      // MONTHLY only. The rebuild pass that follows this only ever builds
      // monthly invoices, so voiding a draft retainer here would throw it away
      // with nothing to put it back — and it was issued by hand, deliberately,
      // which is the opposite of a stale generated snapshot.
      if ((invoice.kind ?? 'monthly') !== 'monthly') continue
      if (invoice.status !== 'draft' && invoice.status !== 'reviewed') continue
      invoice.status = 'void'
      invoice.updatedAt = nowIso()
      ids.push(invoice.id)
    }
    // Same read-modify-write, which is this backend's version of the
    // transaction above.
    if (ids.length > 0) {
      const voided = new Set(ids)
      for (const invoice of data.invoices) {
        if (!invoice.appliedToInvoiceId || !voided.has(invoice.appliedToInvoiceId)) continue
        invoice.appliedToInvoiceId = null
        invoice.updatedAt = nowIso()
      }
      // Same release as the Postgres branch, in the same read-modify-write.
      const freeing = new Set(releasing)
      for (const expense of data.recurringReimbursements ?? []) {
        if (!freeing.has(expense.id)) continue
        if (expense.coverageHistory && period in expense.coverageHistory) {
          delete expense.coverageHistory[period]
        }
      }
      await writeFile(localDataPath, JSON.stringify(data, null, 2))
    }
    return { voided: ids.length, ids }
  }

  /**
   * Work out what a save means for the retainer behind it, and REWRITE the
   * credit line's amount to the figure the server is willing to stand behind.
   *
   * Called by `updateInvoice` before the money is recomputed, so everything
   * downstream — subtotal, total, the pay link, the PDF — is derived from a
   * credit the store itself sized. The page's number is a preview; this is the
   * one that counts, which is what stops a hand-rolled PATCH from posting a
   * -$9,999 credit against a $400 invoice.
   *
   * Answers `{ apply, clear }`, each a retainer invoice id or null:
   *   apply — mark this retainer spent on this invoice
   *   clear — release this retainer, because the line that spent it is gone
   *           (or because she swapped it for a different one in the same save)
   *
   * THE RULES THAT ONLY BITE ON A NEW APPLICATION. Everything that decides
   * whether a retainer MAY be spent — the invoice's status, the retainer's
   * status, the invoice's kind — is checked only when this save is the one doing
   * the spending. Re-checking them on every later save would mean an invoice
   * that legitimately carries a credit became unsaveable the moment it was sent,
   * or the moment the retainer's own status moved on; the decision was made once
   * and re-litigating it turns an ordinary edit into a dead end.
   *
   * Mutates the credit line in `next.lineItems` in place. Throws
   * `RetainerCreditError` for anything it will not honor.
   */
  _resolveRetainerCredit({ id, current, next, patch, all }) {
    // Voiding a retainer that has already been given back would strand the
    // credit: the invoice would keep a negative line pointing at a withdrawn
    // document, and the money would be neither on account nor spent. Named
    // rather than silent, because the way out is a specific act on a specific
    // other invoice.
    if (
      current.kind === 'retainer' &&
      next.status === 'void' &&
      current.appliedToInvoiceId
    ) {
      const target = all.find((invoice) => invoice.id === current.appliedToInvoiceId)
      throw new RetainerCreditError(
        `This retainer is applied to ${target?.number ?? current.appliedToInvoiceId} — ` +
          'remove the credit from that invoice first.',
      )
    }

    // Whatever retainer currently believes it was spent on this invoice. Found
    // by the fact on the retainer row rather than by re-reading the old lines,
    // because that row is the record — if the two ever disagree, the row is what
    // another save would refuse.
    const held =
      all.find(
        (invoice) => invoice.kind === 'retainer' && invoice.appliedToInvoiceId === id,
      ) ?? null

    // A VOIDED invoice holds nothing. It was withdrawn, so the money it was
    // going to give back never will be, and leaving the retainer marked against
    // it would strand that money on a document nobody is paying — invisible,
    // because a void does not show up as an invoice anyone is working on.
    if (next.status === 'void') {
      return { apply: null, clear: held?.id ?? null }
    }

    const credits = next.lineItems.filter((line) => line.kind === 'retainer_credit')
    if (credits.length > 1) {
      throw new RetainerCreditError('An invoice can carry only one retainer credit.')
    }

    const credit = credits[0] ?? null
    if (!credit) {
      // The line is gone, so the money goes back on account. Symmetric with
      // applying it, and it happens on the same save.
      return { apply: null, clear: held?.id ?? null }
    }

    // A PATCH that does not touch the lines is not a statement about the credit.
    // "Mark reviewed" on a credited invoice sends only a status, and running it
    // through the checks below would re-litigate a decision it was not making —
    // most sharply if the retainer has since been voided, where marking an
    // invoice reviewed would start failing for a reason that has nothing to do
    // with reviewing it.
    if (
      !Array.isArray(patch?.lineItems) &&
      held &&
      credit.retainerInvoiceId === held.id
    ) {
      return { apply: null, clear: null }
    }

    const retainerId = credit.retainerInvoiceId ?? held?.id ?? null
    const retainer = retainerId
      ? all.find((invoice) => invoice.id === retainerId && invoice.kind === 'retainer')
      : null
    if (!retainer) {
      throw new RetainerCreditError('That retainer credit does not name a retainer we hold.')
    }
    if (retainer.clientId !== current.clientId) {
      throw new RetainerCreditError('That retainer belongs to a different client.')
    }
    // The read-side half of never-twice. The write-side half is the conditional
    // UPDATE in `updateInvoice`; this one exists so the common case gets a
    // sentence instead of a rolled-back transaction.
    if (retainer.appliedToInvoiceId && retainer.appliedToInvoiceId !== id) {
      throw new RetainerCreditError(
        'That retainer has already been applied to another invoice.',
      )
    }

    // Is THIS save the one spending it? Everything below is gated on that.
    const isNewApplication = !held || held.id !== retainer.id
    if (isNewApplication) {
      // A retainer is not a thing you credit against another retainer.
      if (current.kind !== 'monthly') {
        throw new RetainerCreditError(
          'A retainer credit belongs on a monthly invoice, not on another retainer.',
        )
      }
      // Review comes before money leaves. An invoice that has gone out is the
      // client's copy of a promise, and quietly changing what it says by
      // crediting it afterwards is the thing the review step exists to prevent.
      if (!RETAINER_CREDITABLE_STATUSES.has(next.status)) {
        throw new RetainerCreditError(
          'A retainer credit can only be added while the invoice is a draft or reviewed.',
        )
      }
      // Paid is the bar: crediting a client for money that never arrived would
      // be giving away work.
      if (retainer.status !== 'paid') {
        throw new RetainerCreditError(
          'That retainer has not been paid yet, so there is nothing to credit.',
        )
      }
    }

    const amount = retainerCreditAmount(next.lineItems, retainer.total)
    if (amount === 0) {
      throw new RetainerCreditError('There is nothing on this invoice left to credit.')
    }
    credit.amount = amount
    credit.retainerInvoiceId = retainer.id

    return {
      apply: retainer.id,
      // She swapped one retainer for another inside a single save: the old one
      // has to go back on account, or it is spent on an invoice that no longer
      // names it.
      clear: held && held.id !== retainer.id ? held.id : null,
    }
  }

  /**
   * Edit one invoice. Only the fields Brittany can change in I2 are accepted:
   * the lines, the blurb, the due date, and the review status.
   *
   * MONEY IS RECOMPUTED HERE, never taken from the caller. The page sends the
   * lines it wants; `subtotal` and `total` are derived from them server-side,
   * so a stale or malformed tab cannot post a total that disagrees with its own
   * lines. Returns the updated invoice, or null if it does not exist.
   *
   * THE RETAINER CREDIT IS SETTLED HERE, not in the page. Adding the credit line
   * and removing it are both ordinary line edits as far as the editor is
   * concerned; this is where they become the fact on the retainer row. Doing it
   * on the save — in the same transaction as the lines — is what makes the pair
   * inseparable: there is no window in which an invoice carries a credit no
   * retainer is marked against, or a retainer is spent on lines that were never
   * stored. Throws `RetainerCreditError` when the credit cannot be honored.
   *
   * WHAT SHE CHANGED IS RECORDED HERE, in `invoice_review_events` — this is the
   * only place in the app where an invoice's before and after both exist. The
   * actor comes from `opts.actorUserId` (the session user, passed by the route)
   * and NEVER from the patch body: a field the caller supplies is a claim about
   * who acted, not a fact. `original_line_items` is deliberately NOT written
   * here — it is the as-generated snapshot and only `_insertInvoice` sets it.
   */
  async updateInvoice(id, patch = {}, opts = {}) {
    const all = await this.listInvoices()
    const current = all.find((invoice) => invoice.id === id)
    if (!current) return null

    // THE PAID LOCK. Above every field assignment and above the backend split,
    // because it is a fact about the invoice rather than about how it is stored
    // — the file backend has to refuse the same edit Postgres refuses, and a
    // guard sitting inside one branch is a guard the tests cannot see missing.
    //
    // This is the whole of the enforcement. The editor greys itself out from the
    // same predicate, but a greyed-out field is a courtesy, not a rule: the
    // PATCH route is reachable with a stale tab, a replayed request, or curl.
    const lockRefusal = invoiceLockRefusal(current, patch)
    if (lockRefusal) throw new InvoiceLockedError(lockRefusal)

    const next = { ...current }
    if (Array.isArray(patch.lineItems)) {
      next.lineItems = sanitizeInvoiceLines(patch.lineItems, { invoiceKind: current.kind })
    }
    if (typeof patch.blurb === 'string') next.blurb = patch.blurb
    if (typeof patch.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(patch.dueDate)) {
      next.dueDate = patch.dueDate
    }
    if (EDITABLE_INVOICE_STATUSES.has(patch.status)) next.status = patch.status

    // THE GATE. Review is where the owner says "this is what goes to the
    // client", and a line whose covered dates are still a proposal is not
    // something she has said that about.
    //
    // The flag is RE-DERIVED from the ledger, never read from the body. It
    // arrives on the line, so a PATCH is free to send lines with it stripped —
    // `{status:'reviewed', lineItems:[…no flag…]}` walked straight through the
    // version of this that trusted the sanitized input. A gate whose condition
    // the caller supplies is not a gate. The store's own ledger is the only
    // thing here that knows whether she has answered.
    //
    // Void is deliberately still allowed: withdrawing an invoice she does not
    // want to answer for is exactly the right escape.
    next.lineItems = await this._deriveCoverageFlags(next.lineItems, current.period)
    if (next.status === 'reviewed' && hasUnconfirmedCoverage(next.lineItems)) {
      throw new CoverageConfirmationError(
        'Confirm the covered dates on this invoice before marking it reviewed.',
      )
    }

    const retainerWork = this._resolveRetainerCredit({ id, current, next, patch, all })

    // A VOIDED invoice un-bills its covered windows — see
    // `_clearCoverageLedgerForPeriod`. Done from the invoice's OWN stored lines
    // rather than the patch's, because the patch may have removed them and the
    // window still needs releasing.
    const coverageToRelease =
      next.status === 'void' && current.status !== 'void'
        ? this._coveredExpenseIds([current])
        : []

    Object.assign(next, recomputeInvoiceMoney(next.lineItems))
    next.updatedAt = nowIso()

    // Built BEFORE the write, from the two versions that only exist together
    // here. Null when the save changed nothing at all.
    const changes = buildInvoiceChangeDiff(current, next)
    const reviewEvent = changes
      ? {
          id: `invev-${randomUUID().slice(0, 8)}`,
          invoiceId: id,
          clientId: current.clientId,
          period: current.period,
          actorUserId: opts.actorUserId ?? null,
          event: classifyInvoiceReviewEvent(current, next),
          changes,
          createdAt: nowIso(),
        }
      : null

    if (this.pool) {
      // No retainer moved, no window released and nothing to record, so no
      // second row to keep in step — the single statement is still the whole
      // write. An event DOES need the transaction: the record of what she
      // changed and the change itself must land together or not at all.
      if (
        !retainerWork.apply &&
        !retainerWork.clear &&
        coverageToRelease.length === 0 &&
        !reviewEvent
      ) {
        const { rowCount } = await this.pool.query(
          `update invoices
              set line_items = $2::jsonb, subtotal = $3, total = $4, due_date = $5,
                  blurb = $6, status = $7, updated_at = now()
            where id = $1`,
          [
            id,
            JSON.stringify(next.lineItems),
            next.subtotal,
            next.total,
            next.dueDate,
            next.blurb,
            next.status,
          ],
        )
        if (rowCount === 0) return null
        return (await this.listInvoices()).find((invoice) => invoice.id === id) ?? null
      }

      const dbClient = await this.pool.connect()
      try {
        await dbClient.query('BEGIN')
        const { rowCount } = await dbClient.query(
          `update invoices
              set line_items = $2::jsonb, subtotal = $3, total = $4, due_date = $5,
                  blurb = $6, status = $7, updated_at = now()
            where id = $1`,
          [
            id,
            JSON.stringify(next.lineItems),
            next.subtotal,
            next.total,
            next.dueDate,
            next.blurb,
            next.status,
          ],
        )
        if (rowCount === 0) {
          await dbClient.query('ROLLBACK')
          return null
        }

        // Freeing first, so swapping one retainer for another inside a single
        // save cannot trip over its own predecessor.
        if (retainerWork.clear) {
          await dbClient.query(
            `update invoices
                set applied_to_invoice_id = null, updated_at = now()
              where id = $1 and applied_to_invoice_id = $2`,
            [retainerWork.clear, id],
          )
        }

        if (retainerWork.apply) {
          // THE never-twice rule, and it is this WHERE clause rather than the
          // read above: two saves racing both passed that check, and only the
          // one that gets here first finds the column still null. The loser
          // matches no row, rolls the whole save back, and is told why.
          const applied = await dbClient.query(
            `update invoices
                set applied_to_invoice_id = $2, updated_at = now()
              where id = $1
                and kind = 'retainer'
                and status = 'paid'
                and (applied_to_invoice_id is null or applied_to_invoice_id = $2)`,
            [retainerWork.apply, id],
          )
          if (applied.rowCount === 0) {
            await dbClient.query('ROLLBACK')
            throw new RetainerCreditError(
              'That retainer has already been applied to another invoice.',
            )
          }
        }

        // The void and the windows it releases land together, for the same
        // reason the generation pair does.
        if (coverageToRelease.length > 0) {
          await this._clearCoverageLedgerForPeriod(current.period, coverageToRelease, { dbClient })
        }

        if (reviewEvent) {
          await this._insertInvoiceReviewEvent(reviewEvent, { dbClient })
        }

        await dbClient.query('COMMIT')
      } catch (error) {
        // A rollback after a rollback is a no-op; what matters is that a thrown
        // statement never leaves this connection inside an open transaction.
        try {
          await dbClient.query('ROLLBACK')
        } catch {
          /* already rolled back, or the connection is gone */
        }
        throw error
      } finally {
        dbClient.release()
      }
      return (await this.listInvoices()).find((invoice) => invoice.id === id) ?? null
    }

    const data = await readJson(localDataPath)
    if (!Array.isArray(data.invoices)) data.invoices = []
    const index = data.invoices.findIndex((invoice) => invoice.id === id)
    if (index === -1) return null
    data.invoices[index] = next
    // One read-modify-write covers both rows, which is this backend's version of
    // the transaction above.
    if (retainerWork.clear) {
      const held = data.invoices.find((invoice) => invoice.id === retainerWork.clear)
      if (held && held.appliedToInvoiceId === id) {
        held.appliedToInvoiceId = null
        held.updatedAt = nowIso()
      }
    }
    if (retainerWork.apply) {
      const retainer = data.invoices.find((invoice) => invoice.id === retainerWork.apply)
      if (!retainer || (retainer.appliedToInvoiceId && retainer.appliedToInvoiceId !== id)) {
        throw new RetainerCreditError(
          'That retainer has already been applied to another invoice.',
        )
      }
      retainer.appliedToInvoiceId = id
      retainer.updatedAt = nowIso()
    }
    // The windows this void releases, inside the SAME read-modify-write — the
    // file backend's version of the transaction above.
    if (coverageToRelease.length > 0) {
      const releasing = new Set(coverageToRelease)
      for (const expense of data.recurringReimbursements ?? []) {
        if (!releasing.has(expense.id)) continue
        if (expense.coverageHistory && current.period in expense.coverageHistory) {
          delete expense.coverageHistory[current.period]
        }
      }
    }
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    // After the invoice write, not before: an event describing a save that
    // threw would be a record of something that never happened. This backend
    // has no transaction to put them in together, which is the same trade every
    // other endpoint-managed table here makes.
    if (reviewEvent) {
      await this._insertInvoiceReviewEvent(reviewEvent)
    }
    return next
  }

  // ---- Invoice review events: what a human did to an invoice ----
  //
  // Endpoint-managed (NOT part of the bulk /api/app-data write and NOT in the
  // staleness fingerprint), like client notes — so an owner autosave can
  // neither write nor destroy the audit trail. Stored in auth-state on the file
  // backend, `invoice_review_events` on pg. Always returned newest-first.

  /**
   * Append one event. Runs inside the caller's transaction when one is open, so
   * on Postgres the record and the change it describes commit together.
   */
  async _insertInvoiceReviewEvent(event, { dbClient = null } = {}) {
    if (this.pool) {
      await (dbClient ?? this.pool).query(
        `insert into invoice_review_events (
           id, invoice_id, client_id, period, actor_user_id, event, changes, created_at
         )
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, now())`,
        [
          event.id,
          event.invoiceId,
          event.clientId ?? null,
          event.period ?? null,
          event.actorUserId ?? null,
          event.event,
          JSON.stringify(event.changes ?? {}),
        ],
      )
      return event
    }
    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.invoiceReviewEvents)) authState.invoiceReviewEvents = []
    authState.invoiceReviewEvents.push(event)
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return event
  }

  /**
   * The event log, newest first. Filter by invoice, by client, or neither.
   *
   * `limit` is capped rather than optional: this table only grows, and every
   * caller either renders a short history or feeds a prompt.
   */
  async listInvoiceReviewEvents({ invoiceId = null, clientId = null, limit = 50 } = {}) {
    const cap = Math.min(Math.max(Number(limit) || 0, 1), 500)
    if (this.pool) {
      const filters = []
      const params = []
      if (invoiceId) {
        params.push(invoiceId)
        filters.push(`invoice_id = $${params.length}`)
      }
      if (clientId) {
        params.push(clientId)
        filters.push(`client_id = $${params.length}`)
      }
      params.push(cap)
      const { rows } = await this.pool.query(
        `select id, invoice_id, client_id, period, actor_user_id, event, changes, created_at
           from invoice_review_events
          ${filters.length ? `where ${filters.join(' and ')}` : ''}
          order by created_at desc
          limit $${params.length}`,
        params,
      )
      return rows.map(mapInvoiceReviewEventRow)
    }
    const authState = await readJson(localAuthPath)
    const list = Array.isArray(authState.invoiceReviewEvents) ? authState.invoiceReviewEvents : []
    return list
      .filter((event) => (!invoiceId || event.invoiceId === invoiceId))
      .filter((event) => (!clientId || event.clientId === clientId))
      .slice()
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, cap)
  }

  // ---- Invoice AI reviews: what the model said about a draft ----
  //
  // Same storage rules as the events above. History is kept: a re-rate marks
  // the invoice's prior rows superseded rather than replacing them, because the
  // point of the feature is the record over months.

  /**
   * Store one rating and retire the invoice's previous one.
   *
   * The supersede and the insert are ONE transaction on Postgres. Two ratings
   * landing at once would otherwise both survive as current, and every reader
   * here assumes at most one — the badge would then be whichever row the sort
   * happened to reach first.
   *
   * Inputs are sanitized rather than trusted: this row is written from a model's
   * output, so the band is checked against the three that exist and the score is
   * coerced into 0-100. Returns the stored review, or null without an invoice id.
   */
  async createInvoiceAiReview(review = {}) {
    const invoiceId = String(review.invoiceId ?? '').trim()
    if (!invoiceId) return null

    const row = {
      id: `airev-${randomUUID().slice(0, 8)}`,
      invoiceId,
      clientId: review.clientId ?? null,
      period: review.period ?? null,
      model: review.model ?? null,
      confidence: AI_CONFIDENCE_BANDS.has(review.confidence) ? review.confidence : 'medium',
      score: Math.min(Math.max(Math.round(Number(review.score) || 0), 0), 100),
      summary: String(review.summary ?? '').trim().slice(0, 2000),
      concerns: Array.isArray(review.concerns) ? review.concerns : [],
      // Questions come through as the model wrote them, with one exception: an
      // id is filled in when it is missing, because `answerInvoiceAiReviewQuestion`
      // has no other way to name the entry it is answering.
      questions: (Array.isArray(review.questions) ? review.questions : []).map(
        (question, index) => ({
          ...question,
          id: question?.id ?? `q${index + 1}`,
          answer: question?.answer ?? null,
          skipped: Boolean(question?.skipped),
          answeredAt: question?.answeredAt ?? null,
        }),
      ),
      linesFingerprint: review.linesFingerprint ?? null,
      superseded: false,
      createdAt: nowIso(),
    }

    if (this.pool) {
      await this._withTransaction(async (dbClient) => {
        // SERIALIZE RATING WRITES PER INVOICE, before anything reads or writes.
        //
        // The supersede below is a `where superseded = false` over the rows this
        // transaction can SEE, and under READ COMMITTED that is its own snapshot:
        // the background auto-rate and a manual Re-rate can interleave so that
        // each supersedes what it saw and then inserts, leaving TWO current rows.
        // Nothing downstream would report that — `getInvoiceAiReview` takes the
        // newest and the badge simply becomes whichever row the sort reached
        // first, changing between page loads.
        //
        // The lock is transaction-scoped (released at commit or rollback) and
        // keyed on the invoice, so two DIFFERENT invoices still rate in parallel
        // — which matters, because the generate hook rates a whole month at once.
        await dbClient.query('select pg_advisory_xact_lock(hashtext($1))', [invoiceId])
        await dbClient.query(
          `update invoice_ai_reviews set superseded = true
            where invoice_id = $1 and superseded = false`,
          [invoiceId],
        )
        await dbClient.query(
          `insert into invoice_ai_reviews (
             id, invoice_id, client_id, period, model, confidence, score, summary,
             concerns, questions, lines_fingerprint, superseded, created_at
           )
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,false, now())`,
          [
            row.id,
            row.invoiceId,
            row.clientId,
            row.period,
            row.model,
            row.confidence,
            row.score,
            row.summary,
            JSON.stringify(row.concerns),
            JSON.stringify(row.questions),
            row.linesFingerprint,
          ],
        )
      })
      return row
    }

    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.invoiceAiReviews)) authState.invoiceAiReviews = []
    // One read-modify-write covers both halves, which is this backend's version
    // of the transaction above.
    for (const prior of authState.invoiceAiReviews) {
      if (prior.invoiceId === invoiceId) prior.superseded = true
    }
    authState.invoiceAiReviews.push(row)
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return row
  }

  /**
   * The current rating for every invoice in a period — one row each, ready to
   * key by `invoiceId` in the month run.
   *
   * De-duplicated by invoice even though the supersede rule should make that
   * impossible: a row written before a failed supersede would otherwise put two
   * verdicts on one invoice, and newest-wins is the answer either way.
   */
  async listInvoiceAiReviews({ period = null } = {}) {
    let rows
    if (this.pool) {
      const { rows: found } = await this.pool.query(
        `select id, invoice_id, client_id, period, model, confidence, score, summary,
                concerns, questions, lines_fingerprint, superseded, created_at
           from invoice_ai_reviews
          where superseded = false ${period ? 'and period = $1' : ''}
          order by created_at desc`,
        period ? [period] : [],
      )
      rows = found.map(mapInvoiceAiReviewRow)
    } else {
      const authState = await readJson(localAuthPath)
      const list = Array.isArray(authState.invoiceAiReviews) ? authState.invoiceAiReviews : []
      rows = list
        .filter((entry) => !entry.superseded)
        .filter((entry) => !period || entry.period === period)
        .slice()
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    }
    const byInvoice = new Map()
    for (const row of rows) {
      if (!byInvoice.has(row.invoiceId)) byInvoice.set(row.invoiceId, row)
    }
    return [...byInvoice.values()]
  }

  /** The current (non-superseded) rating for one invoice, or null. */
  async getInvoiceAiReview(invoiceId) {
    if (!invoiceId) return null
    if (this.pool) {
      const { rows } = await this.pool.query(
        `select id, invoice_id, client_id, period, model, confidence, score, summary,
                concerns, questions, lines_fingerprint, superseded, created_at
           from invoice_ai_reviews
          where invoice_id = $1 and superseded = false
          order by created_at desc
          limit 1`,
        [invoiceId],
      )
      return rows.length ? mapInvoiceAiReviewRow(rows[0]) : null
    }
    const authState = await readJson(localAuthPath)
    const list = Array.isArray(authState.invoiceAiReviews) ? authState.invoiceAiReviews : []
    return (
      list
        .filter((entry) => entry.invoiceId === invoiceId && !entry.superseded)
        .slice()
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null
    )
  }

  /**
   * Record Brittany's answer to one of the rating's questions — or her decision
   * to skip it. Returns the updated review.
   *
   * Answers land on the CURRENT review only. A rating that has been superseded
   * is a verdict on lines that have since moved, and writing an answer onto it
   * would file the answer somewhere nothing reads. Throws `InvoiceAiReviewError`
   * when there is no current review or no question by that id — both mean the
   * page she is looking at is out of date, which she needs told.
   */
  async answerInvoiceAiReviewQuestion(invoiceId, questionId, { answer = null, skipped = false } = {}) {
    const current = await this.getInvoiceAiReview(invoiceId)
    if (!current) {
      throw new InvoiceAiReviewError('That invoice has no current AI review to answer.')
    }
    const questions = Array.isArray(current.questions) ? current.questions : []
    const index = questions.findIndex((question) => question?.id === questionId)
    if (index === -1) {
      throw new InvoiceAiReviewError('That review has no question by that id.')
    }

    const nextQuestions = questions.map((question, position) =>
      position === index
        ? {
            ...question,
            answer: skipped ? (question.answer ?? null) : String(answer ?? '').trim(),
            skipped: Boolean(skipped),
            answeredAt: nowIso(),
          }
        : question,
    )

    // THE RE-RATE RACE, and it is this WHERE clause rather than the read above:
    // a rating that arrived while she was typing superseded the row she is
    // answering, and an unguarded update would file her answer onto it. Nothing
    // reads a superseded row, so the page would show the question answered and
    // the next fetch would show it unanswered again — her words simply gone.
    // Matching no row is the honest outcome, and 409 says so.
    if (this.pool) {
      const { rowCount } = await this.pool.query(
        `update invoice_ai_reviews set questions = $2::jsonb
          where id = $1 and superseded = false`,
        [current.id, JSON.stringify(nextQuestions)],
      )
      if (rowCount === 0) {
        throw new InvoiceAiReviewError(
          'That review was replaced by a newer rating — refresh and answer there.',
          409,
        )
      }
      return { ...current, questions: nextQuestions }
    }
    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.invoiceAiReviews)) authState.invoiceAiReviews = []
    const stored = authState.invoiceAiReviews.find((entry) => entry.id === current.id)
    if (!stored) {
      throw new InvoiceAiReviewError('That invoice has no current AI review to answer.')
    }
    // The same guard, re-checked against what is on disk NOW — this backend's
    // version of the WHERE clause above.
    if (stored.superseded) {
      throw new InvoiceAiReviewError(
        'That review was replaced by a newer rating — refresh and answer there.',
        409,
      )
    }
    stored.questions = nextQuestions
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return stored
  }

  /**
   * The corpus the rating prompt learns from: what Brittany has already told the
   * model, and what she has actually corrected.
   *
   * Two scopes, both newest-first and both capped. This client's history is what
   * matters most — her rules for one client rarely generalize — but a few
   * firm-wide entries carry the habits that do (how she words a description,
   * which months she trues up). The firm slice deliberately EXCLUDES this client
   * so the two lists never say the same thing twice.
   *
   * Entries are summaries, not records. This goes into a prompt beside the draft
   * being rated, and two full line arrays per correction would crowd out the
   * thing being judged.
   */
  async listInvoiceLearningContext(clientId, { limit = 8, firmLimit = 4 } = {}) {
    const clientCap = Math.min(Math.max(Number(limit) || 0, 0), 50)
    const firmCap = Math.min(Math.max(Number(firmLimit) || 0, 0), 50)

    const reviews = await this._listAllInvoiceAiReviews()
    const answeredFrom = (rows, scope) => {
      const out = []
      for (const review of rows) {
        for (const question of Array.isArray(review.questions) ? review.questions : []) {
          if (!question || question.skipped) continue
          const answer = String(question.answer ?? '').trim()
          if (!answer) continue
          out.push({
            scope,
            period: review.period ?? null,
            clientId: review.clientId ?? null,
            question: String(question.question ?? '').slice(0, 300),
            answer: answer.slice(0, 500),
            answeredAt: question.answeredAt ?? review.createdAt ?? null,
          })
        }
      }
      return out
    }

    const answeredQuestions = [
      ...answeredFrom(
        reviews.filter((review) => review.clientId === clientId),
        'client',
      ).slice(0, clientCap),
      ...answeredFrom(
        reviews.filter((review) => review.clientId !== clientId),
        'firm',
      ).slice(0, firmCap),
    ]

    // Only 'edited' events with a lineItems change are corrections. A status
    // move is her workflow, not a fix, and feeding it back as one would teach
    // the model that approving an invoice means something was wrong with it.
    const events = await this.listInvoiceReviewEvents({ limit: 500 })
    const correctionsFrom = (rows, scope) =>
      rows
        .filter((event) => event.event === 'edited' && event.changes?.lineItems)
        .map((event) => ({
          scope,
          period: event.period ?? null,
          clientId: event.clientId ?? null,
          invoiceId: event.invoiceId,
          at: event.createdAt ?? null,
          ...summarizeLineItemChange(
            event.changes.lineItems.before,
            event.changes.lineItems.after,
          ),
        }))

    const corrections = [
      ...correctionsFrom(
        events.filter((event) => event.clientId === clientId),
        'client',
      ).slice(0, clientCap),
      ...correctionsFrom(
        events.filter((event) => event.clientId !== clientId),
        'firm',
      ).slice(0, firmCap),
    ]

    return { answeredQuestions, corrections }
  }

  /**
   * Every rating ever written, newest first — superseded ones included.
   *
   * The learning context wants ALL of them: an answer Brittany gave in June is
   * still her answer after a July re-rate superseded the row it lives on.
   */
  async _listAllInvoiceAiReviews() {
    if (this.pool) {
      const { rows } = await this.pool.query(
        `select id, invoice_id, client_id, period, model, confidence, score, summary,
                concerns, questions, lines_fingerprint, superseded, created_at
           from invoice_ai_reviews
          order by created_at desc
          limit 500`,
      )
      return rows.map(mapInvoiceAiReviewRow)
    }
    const authState = await readJson(localAuthPath)
    const list = Array.isArray(authState.invoiceAiReviews) ? authState.invoiceAiReviews : []
    return list
      .slice()
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, 500)
  }

  /**
   * Remember a Stripe customer id on a client, so a second invoice reuses the
   * same customer rather than creating a duplicate in Stripe.
   */
  async setClientStripeCustomerId(clientId, customerId) {
    if (this.pool) {
      await this.pool.query(
        'update clients set stripe_customer_id = $2, updated_at = now() where id = $1',
        [clientId, customerId],
      )
      return
    }
    const data = await readJson(localDataPath)
    const client = (data.clients ?? []).find((entry) => entry.id === clientId)
    if (!client) return
    client.stripeCustomerId = customerId
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  }

  /**
   * Record a Stripe event id the FIRST time we see it.
   *
   * @returns {boolean} true if this is new, false if already processed.
   *
   * Stripe retries a webhook until it gets a 2xx, and can deliver out of order,
   * so the same event legitimately arrives more than once. Without this a retry
   * of `payment_intent.succeeded` would re-stamp `paid_at` and re-notify — the
   * ledger equivalent of counting the same payment twice.
   */
  async recordStripeEventOnce(eventId, eventType) {
    if (!eventId) return false
    if (this.pool) {
      const { rowCount } = await this.pool.query(
        `insert into stripe_events (id, type) values ($1, $2)
         on conflict (id) do nothing`,
        [eventId, String(eventType ?? '')],
      )
      return rowCount > 0
    }
    const data = await readJson(localDataPath)
    if (!Array.isArray(data.stripeEvents)) data.stripeEvents = []
    if (data.stripeEvents.some((entry) => entry.id === eventId)) return false
    data.stripeEvents.push({ id: eventId, type: String(eventType ?? ''), at: nowIso() })
    // Keep the log bounded — this is a dedup ledger, not history.
    if (data.stripeEvents.length > 500) data.stripeEvents = data.stripeEvents.slice(-500)
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return true
  }

  /**
   * Apply a payment-side change to one invoice: the Stripe ids, the status, and
   * the paid stamp. Deliberately narrow — this is the only path a WEBHOOK can
   * take into an invoice, so it cannot rewrite lines, amounts or the number.
   *
   * The ONE exception is `appendLines`, which exists for the card processing
   * fee. When a client pays by card they are charged the invoice plus a fee, and
   * the invoice of record has to show the money that actually arrived — History,
   * the month run and the QBO export all read those lines. So the fee line is
   * appended and the totals are recomputed by the SAME calculator the PATCH uses,
   * in the same write that marks the payment. It can only ADD, never edit or
   * remove, and a line kind already present is not appended again: Stripe sends
   * both `checkout.session.completed` and `payment_intent.succeeded` for one card
   * payment, and two fee lines for one fee would be an overcharge on the record.
   */
  async applyInvoicePayment(invoiceId, patch = {}) {
    const current = (await this.listInvoices()).find((invoice) => invoice.id === invoiceId)
    if (!current) return null
    // Same race as `recordInvoiceSent`: a webhook or a payment-link request can
    // land after "Void & regenerate" voided the row it names. Reviving it would
    // break the live-per-(client, period) index on Postgres and duplicate the
    // live invoice on the file backend, so the late write is dropped instead.
    if (current.status === 'void') {
      console.warn(`[invoices] applyInvoicePayment skipped: ${invoiceId} is void`)
      return null
    }

    const next = { ...current }
    if (PAYMENT_INVOICE_STATUSES.has(patch.status)) next.status = patch.status
    /**
     * PAID IS STICKY against payment-side writes. A card payment fires two
     * webhook events nearly at once, and Stripe does not promise their order:
     * when `payment_intent.succeeded` lands first (status -> 'paid') and
     * `checkout.session.completed` lands second, the second used to write its
     * 'processing' over the settled truth — INV-2026-08-003 sat that way for
     * twelve days with paid_at and the card method already on the row. The
     * late event's OTHER facts (session ids, the fee line) still apply below;
     * only the status cannot go backwards. Nothing here touches void — that
     * is updateInvoice's machinery, deliberately.
     */
    if (current.status === 'paid' && next.status !== 'paid') next.status = 'paid'
    // Surfaced to the caller (never persisted) so the webhook can tell a real
    // transition from a replay before it emails the client about it.
    const statusChanged = next.status !== current.status
    if (typeof patch.checkoutSessionId === 'string') {
      next.stripeCheckoutSessionId = patch.checkoutSessionId
    }
    if (typeof patch.cardCheckoutSessionId === 'string') {
      next.stripeCardSessionId = patch.cardCheckoutSessionId
    }
    if (typeof patch.paymentIntentId === 'string') {
      next.stripePaymentIntentId = patch.paymentIntentId
    }
    if (typeof patch.paymentMethod === 'string') next.paymentMethod = patch.paymentMethod
    if (patch.paidAt === null || typeof patch.paidAt === 'string') next.paidAt = patch.paidAt
    if (patch.sentAt === null || typeof patch.sentAt === 'string') next.sentAt = patch.sentAt

    // Additive only, and only for a kind the invoice does not already carry.
    const appended = sanitizeInvoiceLines(patch.appendLines, {
      invoiceKind: current.kind,
    }).filter(
      (line) => !(current.lineItems ?? []).some((existing) => existing.kind === line.kind),
    )
    const linesChanged = appended.length > 0
    if (linesChanged) {
      next.lineItems = [...(current.lineItems ?? []), ...appended]
      Object.assign(next, recomputeInvoiceMoney(next.lineItems))
    }
    next.updatedAt = nowIso()

    if (this.pool) {
      // The money columns are only in the statement when a line was actually
      // appended. Writing them on every payment event would turn this into a
      // read-modify-write over the lines, and an edit made between the read
      // above and this update would be silently reverted by a webhook.
      const params = [
        invoiceId,
        next.status,
        next.stripeCheckoutSessionId ?? null,
        next.stripePaymentIntentId ?? null,
        next.paymentMethod ?? null,
        next.paidAt ?? null,
        next.sentAt ?? null,
        next.stripeCardSessionId ?? null,
      ]
      if (linesChanged) params.push(JSON.stringify(next.lineItems), next.subtotal, next.total)
      const { rowCount } = await this.pool.query(
        `update invoices
            set status = $2, stripe_checkout_session_id = $3, stripe_payment_intent_id = $4,
                payment_method = $5, paid_at = $6, sent_at = $7,
                stripe_card_session_id = $8${
                  linesChanged
                    ? ', line_items = $9::jsonb, subtotal = $10, total = $11'
                    : ''
                },
                updated_at = now()
          where id = $1`,
        params,
      )
      if (rowCount === 0) return null
      return withStatusChanged(
        (await this.listInvoices()).find((invoice) => invoice.id === invoiceId) ?? null,
        statusChanged,
      )
    }

    const data = await readJson(localDataPath)
    if (!Array.isArray(data.invoices)) data.invoices = []
    const index = data.invoices.findIndex((invoice) => invoice.id === invoiceId)
    if (index === -1) return null
    data.invoices[index] = next
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return withStatusChanged(next, statusChanged)
  }

  /**
   * Mark an invoice paid BY HAND — featreq-602d2c6e, for money that arrived
   * outside the app (a paper check, a bank transfer nobody linked, an invoice
   * that was never sent through the system at all).
   *
   * Allowed from `draft`, `reviewed`, `sent` and `overdue`. The refusals are
   * the design:
   *
   *   - `processing` is REFUSED: a real ACH debit is settling against this
   *     invoice, tracked by webhook. Marking it paid by hand mid-flight would
   *     have the webhook's answer and hers racing for the same row — let the
   *     bank finish.
   *   - `void` is refused — a withdrawn document cannot be paid; `paid` is
   *     refused because it already is.
   *
   * `paymentMethod: 'manual'` is the durable mark that a HUMAN said this, not
   * Stripe — it is what makes the undo below safe to offer, and what the UI
   * reads to say "marked paid by hand". The actor lands in
   * `invoice_review_events`, because "who said this was paid" is an audit
   * question with a months-later shelf life.
   *
   * The caller (the route) expires any open checkout sessions AFTER this
   * commits — an emailed pay button that still charges a client who already
   * paid by check is the one disaster this feature could cause.
   */
  async markInvoicePaidManually(invoiceId, { actorUserId = null } = {}) {
    const current = (await this.listInvoices()).find((invoice) => invoice.id === invoiceId)
    if (!current) return null
    if (current.status === 'void') {
      throw new ManualPaymentError('This invoice was voided — a withdrawn invoice cannot be paid.')
    }
    if (current.status === 'paid') {
      throw new ManualPaymentError('This invoice is already paid.')
    }
    if (current.status === 'processing') {
      throw new ManualPaymentError(
        'A bank payment is already going through against this invoice — let it settle instead of marking it by hand.',
      )
    }

    const paidAt = nowIso()
    const reviewEvent = {
      id: `invev-${randomUUID().slice(0, 8)}`,
      invoiceId,
      clientId: current.clientId,
      period: current.period,
      actorUserId,
      event: 'marked_paid_manually',
      changes: { status: { before: current.status, after: 'paid' } },
      createdAt: paidAt,
    }

    if (this.pool) {
      const dbClient = await this.pool.connect()
      try {
        await dbClient.query('begin')
        const { rowCount } = await dbClient.query(
          `update invoices
              set status = 'paid', payment_method = 'manual', paid_at = $2, updated_at = now()
            where id = $1`,
          [invoiceId, paidAt],
        )
        if (rowCount === 0) {
          await dbClient.query('rollback')
          return null
        }
        await this._insertInvoiceReviewEvent(reviewEvent, { dbClient })
        await dbClient.query('commit')
      } catch (error) {
        await dbClient.query('rollback')
        throw error
      } finally {
        dbClient.release()
      }
      return (await this.listInvoices()).find((invoice) => invoice.id === invoiceId) ?? null
    }

    const data = await readJson(localDataPath)
    if (!Array.isArray(data.invoices)) data.invoices = []
    const index = data.invoices.findIndex((invoice) => invoice.id === invoiceId)
    if (index === -1) return null
    const next = {
      ...data.invoices[index],
      status: 'paid',
      paymentMethod: 'manual',
      paidAt,
      updatedAt: paidAt,
    }
    data.invoices[index] = next
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    await this._insertInvoiceReviewEvent(reviewEvent)
    return next
  }

  /**
   * Confirm with Stripe that a 'processing' invoice actually settled, and say
   * so — the stuck-invoice fix, driven by STRIPE'S answer rather than a
   * human's memory of it. The route queries the payment intent first; this
   * method only records what Stripe confirmed, stamps paidAt from the charge,
   * and writes the audit event. paymentMethod is deliberately untouched: the
   * webhook already recorded how the money moved.
   */
  async reconcileProcessingInvoicePaid(invoiceId, { paidAt = null, actorUserId = null } = {}) {
    const current = (await this.listInvoices()).find((invoice) => invoice.id === invoiceId)
    if (!current) return null
    if (current.status === 'paid') {
      throw new ManualPaymentError('This invoice is already paid.')
    }
    if (current.status !== 'processing') {
      throw new ManualPaymentError(
        'Only an invoice with a payment going through can be reconciled with Stripe.',
      )
    }

    const settledAt = paidAt ?? current.paidAt ?? nowIso()
    const reviewEvent = {
      id: `invev-${randomUUID().slice(0, 8)}`,
      invoiceId,
      clientId: current.clientId,
      period: current.period,
      actorUserId,
      event: 'payment_verified_with_stripe',
      changes: { status: { before: 'processing', after: 'paid' } },
      createdAt: nowIso(),
    }

    if (this.pool) {
      const dbClient = await this.pool.connect()
      try {
        await dbClient.query('begin')
        const { rowCount } = await dbClient.query(
          `update invoices
              set status = 'paid', paid_at = $2, updated_at = now()
            where id = $1 and status = 'processing'`,
          [invoiceId, settledAt],
        )
        if (rowCount === 0) {
          await dbClient.query('rollback')
          return null
        }
        await this._insertInvoiceReviewEvent(reviewEvent, { dbClient })
        await dbClient.query('commit')
      } catch (error) {
        await dbClient.query('rollback')
        throw error
      } finally {
        dbClient.release()
      }
      return (await this.listInvoices()).find((invoice) => invoice.id === invoiceId) ?? null
    }

    const data = await readJson(localDataPath)
    if (!Array.isArray(data.invoices)) data.invoices = []
    const index = data.invoices.findIndex((invoice) => invoice.id === invoiceId)
    if (index === -1) return null
    const next = { ...data.invoices[index], status: 'paid', paidAt: settledAt, updatedAt: nowIso() }
    data.invoices[index] = next
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    await this._insertInvoiceReviewEvent(reviewEvent)
    return next
  }

  /**
   * Take back a MANUAL payment mark — the mis-click escape, so a wrong "mark
   * paid" does not leave void-and-regenerate as the only way out of the paid
   * lock.
   *
   * Deliberately narrow: only an invoice whose `paymentMethod` is `'manual'`
   * and which carries NO Stripe payment intent may be un-marked. A webhook-paid
   * invoice is a record of real money moving and stays exactly what it is.
   * The invoice returns to `sent` if it had ever been sent, else `reviewed` —
   * the state it most plausibly left.
   */
  async unmarkManualInvoicePayment(invoiceId, { actorUserId = null } = {}) {
    const current = (await this.listInvoices()).find((invoice) => invoice.id === invoiceId)
    if (!current) return null
    if (current.status !== 'paid' || current.paymentMethod !== 'manual') {
      throw new ManualPaymentError('Only an invoice marked paid by hand can be un-marked.')
    }
    if (current.stripePaymentIntentId) {
      throw new ManualPaymentError(
        'A real payment is recorded against this invoice — it cannot be un-marked.',
      )
    }

    const restored = current.sentAt ? 'sent' : 'reviewed'
    const now = nowIso()
    const reviewEvent = {
      id: `invev-${randomUUID().slice(0, 8)}`,
      invoiceId,
      clientId: current.clientId,
      period: current.period,
      actorUserId,
      event: 'manual_payment_undone',
      changes: { status: { before: 'paid', after: restored } },
      createdAt: now,
    }

    if (this.pool) {
      const dbClient = await this.pool.connect()
      try {
        await dbClient.query('begin')
        const { rowCount } = await dbClient.query(
          `update invoices
              set status = $2, payment_method = null, paid_at = null, updated_at = now()
            where id = $1 and status = 'paid' and payment_method = 'manual'`,
          [invoiceId, restored],
        )
        if (rowCount === 0) {
          await dbClient.query('rollback')
          return null
        }
        await this._insertInvoiceReviewEvent(reviewEvent, { dbClient })
        await dbClient.query('commit')
      } catch (error) {
        await dbClient.query('rollback')
        throw error
      } finally {
        dbClient.release()
      }
      return (await this.listInvoices()).find((invoice) => invoice.id === invoiceId) ?? null
    }

    const data = await readJson(localDataPath)
    if (!Array.isArray(data.invoices)) data.invoices = []
    const index = data.invoices.findIndex((invoice) => invoice.id === invoiceId)
    if (index === -1) return null
    const next = {
      ...data.invoices[index],
      status: restored,
      paymentMethod: null,
      paidAt: null,
      updatedAt: now,
    }
    data.invoices[index] = next
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    await this._insertInvoiceReviewEvent(reviewEvent)
    return next
  }


  /**
   * Record that an email about an invoice went out, and — for the invoice
   * itself — mark it sent.
   *
   * The log is append-only and keeps every send, including re-sends — "did she
   * actually send this, and when" is a question that comes up months later when
   * a client says they never got it. `sentAt` keeps the FIRST send, because
   * that is the date the clock started for payment terms.
   *
   * `kind` tags the payment-side emails the Stripe webhook sends the client:
   * `'ack'` when a bank payment starts, `'receipt'` when it completes. Those
   * are records of a PAYMENT, not of the invoice going out, so they are logged
   * without touching `sentAt` or the status — an untouched `kind` (every entry
   * written before this existed, and every real invoice send) keeps the
   * original behavior exactly.
   */
  async recordInvoiceSent(
    invoiceId,
    { to = [], subject = '', ok = true, error = null, kind = null } = {},
  ) {
    const current = (await this.listInvoices()).find((invoice) => invoice.id === invoiceId)
    if (!current) return null
    // A void invoice is not a thing that can be sent. The send route already
    // refuses one up front; what this catches is the MID-FLIGHT race that "Void
    // & regenerate" made real — the invoice was voided while this send was in
    // the air. Writing 'sent' back onto it would collide with the live-per-
    // (client, period) index on Postgres (a 500 after the email had already
    // left), and on the file backend would quietly leave two live invoices for
    // one client. Refusing is the only safe answer; the caller sees null.
    if (current.status === 'void') {
      console.warn(`[invoices] recordInvoiceSent skipped: ${invoiceId} is void`)
      return null
    }

    const entry = {
      at: nowIso(),
      to: Array.isArray(to) ? to : [to].filter(Boolean),
      subject: String(subject ?? ''),
      ok: Boolean(ok),
      // What was actually billed at the moment it went out. The lines can be
      // edited after a send, so without this the log records that an email left
      // but not what the client was asked to pay.
      total: Number(current.total) || 0,
      ...(kind ? { kind: String(kind) } : {}),
      ...(error ? { error: String(error).slice(0, 300) } : {}),
    }
    // Only the invoice going out marks the invoice sent. A payment receipt is
    // logged on the same append-only trail but must not restart the payment
    // clock or rewrite a status the webhook just set.
    const marksSent = Boolean(ok) && !kind
    if (this.pool) {
      // The entry is APPENDED server-side, deliberately: `current` above is a
      // read, and building `[...current.emailLog, entry]` in JS means the log
      // is only as complete as that read was. It was not — `email_log` was
      // missing from the select, so every send rewrote the log with a
      // one-entry array. Concatenating in SQL is immune to both that and to
      // two sends racing: whatever is in the column, this adds to it.
      //
      // `sent_at` and `status` are decided from the row's OWN values for the
      // same reason, and a failed attempt (ok = false) is logged without
      // touching either. The void guard stays a pre-read above.
      const { rowCount } = await this.pool.query(
        `update invoices
            set email_log = coalesce(email_log, '[]'::jsonb) || $2::jsonb,
                sent_at = case when $3::boolean then coalesce(sent_at, $4::timestamptz)
                               else sent_at end,
                status = case when $3::boolean and status <> 'paid' and status <> 'processing'
                              then 'sent' else status end,
                updated_at = now()
          where id = $1`,
        [invoiceId, JSON.stringify([entry]), marksSent, entry.at],
      )
      if (rowCount === 0) return null
      return (await this.listInvoices()).find((invoice) => invoice.id === invoiceId) ?? null
    }

    // Same semantics, spelled out in JS. The file backend's read IS the whole
    // file, so appending here cannot drop entries the way the Postgres
    // read-modify-write did — the branch above concatenates in SQL on purpose.
    const emailLog = [...(current.emailLog ?? []), entry]
    // A failed attempt — and a payment-side email of any kind — is logged but
    // must NOT claim the invoice was sent.
    const sentAt = marksSent ? (current.sentAt ?? entry.at) : current.sentAt
    const status = marksSent && current.status !== 'paid' && current.status !== 'processing'
      ? 'sent'
      : current.status

    const data = await readJson(localDataPath)
    if (!Array.isArray(data.invoices)) data.invoices = []
    const index = data.invoices.findIndex((invoice) => invoice.id === invoiceId)
    if (index === -1) return null
    data.invoices[index] = { ...current, emailLog, sentAt, status, updatedAt: nowIso() }
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return data.invoices[index]
  }

  /**
   * Find an invoice by the Stripe ids a webhook carries.
   *
   * A card-enabled client's invoice has TWO live Checkout sessions, so a session
   * id is matched against either column — the card session is just as valid a
   * name for the invoice as the ACH one.
   */
  async findInvoiceByStripeRef({ invoiceId, checkoutSessionId, paymentIntentId }) {
    const all = await this.listInvoices()
    return (
      all.find((invoice) => invoiceId && invoice.id === invoiceId) ??
      all.find(
        (invoice) =>
          checkoutSessionId &&
          (invoice.stripeCheckoutSessionId === checkoutSessionId ||
            invoice.stripeCardSessionId === checkoutSessionId),
      ) ??
      all.find(
        (invoice) => paymentIntentId && invoice.stripePaymentIntentId === paymentIntentId,
      ) ??
      null
    )
  }

  /**
   * Insert one invoice; null when the live-monthly-per-(client, period) index
   * refuses it.
   *
   * The `on conflict` inference names the index's own predicate, which is what
   * picks `invoices_client_period_monthly_live` as the arbiter. A RETAINER row
   * does not satisfy that predicate, so it can never conflict — which is the
   * whole point: a retainer is allowed to sit in the same month as the client's
   * monthly invoice, and two live retainers for one client are allowed too
   * (a second engagement is a second retainer).
   */
  async _insertInvoice(record, { dbClient = null } = {}) {
    const kind = record.kind ?? 'monthly'
    // The as-generated snapshot, set HERE so it cannot depend on a caller
    // remembering. It is written once, on this statement, and by nothing else
    // ever after — `updateInvoice` deliberately leaves the column alone, which
    // is the whole point of having it.
    const originalLineItems = record.originalLineItems ?? record.lineItems ?? null
    if (this.pool) {
      // Runs inside the caller's transaction when one is open, so the invoice
      // and the covered-date ledger it moves commit together — see
      // `generateInvoicesForPeriod`.
      const { rows } = await (dbClient ?? this.pool).query(
        `insert into invoices (
           id, client_id, period, number, kind, status, line_items, subtotal, total,
           due_date, blurb, scope_flags, original_line_items, created_at, updated_at
         )
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12::jsonb,$13::jsonb, now(), now())
         on conflict (client_id, period) where kind = 'monthly' and status <> 'void' do nothing
         returning id`,
        [
          record.id,
          record.clientId,
          record.period,
          record.number,
          kind,
          record.status,
          JSON.stringify(record.lineItems),
          record.subtotal,
          record.total,
          record.dueDate,
          record.blurb,
          JSON.stringify(record.scopeFlags),
          originalLineItems ? JSON.stringify(originalLineItems) : null,
        ],
      )
      return rows.length > 0 ? { ...record, originalLineItems } : null
    }

    const data = await readJson(localDataPath)
    if (!Array.isArray(data.invoices)) data.invoices = []
    // Mirror the partial unique index by hand — the file backend has no
    // constraints, and cardinal rule 1 means it has to behave the same. Kind is
    // part of the mirror: only a MONTHLY invoice can be blocked, and only by
    // another monthly one.
    const clash =
      kind === 'monthly' &&
      data.invoices.some(
        (invoice) =>
          (invoice.kind ?? 'monthly') === 'monthly' &&
          invoice.clientId === record.clientId &&
          invoice.period === record.period &&
          invoice.status !== 'void',
      )
    if (clash) return null
    // Same snapshot the Postgres branch writes — cardinal rule 1. Spreading the
    // record rather than mutating the caller's object keeps the two branches
    // returning the same shape.
    const stored = { ...record, originalLineItems }
    data.invoices.push(stored)
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return stored
  }

  async createClient(client) {
    const id = client.id ?? `client-${randomUUID().slice(0, 8)}`
    const name = String(client.name ?? '').trim()
    if (!name) return null

    const stringIds = (value) =>
      Array.isArray(value) ? value.filter((entry) => typeof entry === 'string' && entry) : []

    // ONE assigned team. The Add-client form sends `assignedEmployeeIds`; the
    // rest of the app writes `assignedBookkeeperIds`. Only the latter gates
    // visibility, so a payload carrying just the former used to create a client
    // its own team could not see. Accept either name, fold into one value.
    const assignedTeam = [
      ...new Set([
        ...stringIds(client.assignedBookkeeperIds),
        ...stringIds(client.assignedEmployeeIds),
      ]),
    ]

    // Normalize through the same profile mapper the reads use, so the record
    // handed back to the creating tab has the exact shape a reload produces.
    const record = normalizeClientProfile({
      ...client,
      id,
      name,
      contact: String(client.contact ?? ''),
      billingMode: client.billingMode ?? 'hourly',
      hourlyRate: clampMoney(client.hourlyRate ?? 0),
      planIds: stringIds(client.planIds),
      contactIds: stringIds(client.contactIds),
      // One team, two names — `assignedEmployeeIds` is a derived alias kept
      // for the UI until batch 2 removes it.
      assignedEmployeeIds: assignedTeam,
      assignedBookkeeperIds: assignedTeam,
      // Never let a bad value land in the stage column — absent/garbage is
      // 'active', matching write() and the read mappers.
      lifecycleStage: coerceLifecycleStage(client.lifecycleStage),
    })

    // Consolidated billing, checked OUT LOUD. A create is one deliberate act
    // with a person waiting on the answer, so a link that does not hold is a
    // sentence rather than a silently-nulled field — the opposite call from the
    // bulk save, and for the opposite reason (see `billingLinkRefusal`). The
    // roster read is skipped entirely for the ordinary create, which sets none
    // of the three.
    if (record.billToClientId || record.isBillingMaster || record.invoiceRecipientClientId) {
      const roster = this.pool
        ? (
            await this.pool.query(
              `select id, name, is_billing_master as "isBillingMaster",
                      bill_to_client_id as "billToClientId"
                 from clients`,
            )
          ).rows
        : (await readJson(localDataPath)).clients ?? []
      const refusal = billingLinkRefusal(record, roster)
      if (refusal) throw new BillingMasterError(refusal)
    }

    if (this.pool) {
      // Optional numeric column: null when absent, clamped otherwise — the
      // treatment sanitizeAppData + write() give these on a bulk save.
      const money = (value) =>
        value === undefined || value === null || value === '' ? null : clampMoney(value)
      const annualBillingMonth = Number(record.annualBillingMonth)

      const dbClient = await this.pool.connect()
      try {
        await dbClient.query('begin')

        // Resolve the primary contact to a REAL contact record, here and now.
        // This used to be left to a backfill on the next read, so immediately
        // after saving there was nothing in the Contacts directory to find.
        // Done inside the transaction: if the client insert fails we must not
        // leave an orphaned contact behind.
        const { rows: existingContacts } = await dbClient.query(
          'select id, name, email, archived_at as "archivedAt" from contacts',
        )
        const plan = planPrimaryContact({
          contacts: existingContacts,
          primaryContactId: client.primaryContactId,
          newPrimaryContact: client.newPrimaryContact,
          contactIds: record.contactIds,
        })
        let primaryContactId = plan.primaryContactId
        if (plan.create) {
          primaryContactId = `contact-${randomUUID().slice(0, 8)}`
          await dbClient.query(
            `insert into contacts (id, name, email, phone, updated_at)
             values ($1, $2, $3, $4, now())`,
            [primaryContactId, plan.create.name, plan.create.email, plan.create.phone],
          )
        }
        record.contactIds = mergeContactIds(primaryContactId, plan.otherContactIds)
        // Keep the denormalized display name in step — the client table renders
        // it, and every existing client relies on it.
        record.contact = plan.contactName || record.contact

        // `plan_id` (the legacy single-plan FK column) is deliberately left at
        // its null default: `plan_ids` is the live field and the read mapper
        // only falls back to `plan_id` when `plan_ids` is empty. Writing it
        // would need the plan list on hand to avoid a dangling FK.
        await dbClient.query(
          `insert into clients (
             id, name, contact, billing_mode, hourly_rate,
             custom_monthly_fee, monthly_rate, estimated_monthly_hours,
             plan_ids, contact_ids,
             email, contact_name, phone, address_line1, address_line2,
             city, state, postal_code, logo_url, payment_terms,
             footer_note, quickbooks_pay_url, invoice_show_time_breakdown,
             invoice_hide_internal_hours, invoice_group_by_category,
             assigned_bookkeeper_ids,
             estimated_bookkeeper_hours, estimated_accountant_hours,
             estimated_cfo_hours, monthly_service_tier,
             annual_rate, annual_billing_month, lifecycle_stage,
             card_payments_enabled,
             invoice_time_breakdown_mode, invoice_time_breakdown_amounts,
             bill_to_client_id, is_billing_master, invoice_recipient_client_id, updated_at
           )
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39, now())`,
          [
            record.id,
            record.name,
            record.contact,
            record.billingMode,
            record.hourlyRate,
            money(record.customMonthlyFee),
            money(record.monthlyRate),
            money(record.estimatedMonthlyHours),
            record.planIds,
            record.contactIds,
            record.email ?? '',
            record.contactName ?? '',
            record.phone ?? '',
            record.addressLine1 ?? '',
            record.addressLine2 ?? '',
            record.city ?? '',
            record.state ?? '',
            record.postalCode ?? '',
            record.logoUrl ?? '',
            record.paymentTerms ?? '',
            record.footerNote ?? '',
            // Only persist a safe http(s) pay link — never a javascript:/data: URL.
            isSafeHttpUrl(record.quickbooksPayUrl) ? record.quickbooksPayUrl : '',
            record.invoiceShowTimeBreakdown ?? true,
            record.invoiceHideInternalHours ?? true,
            record.invoiceGroupByCategory ?? false,
            [...new Set(record.assignedBookkeeperIds)],
            money(record.estimatedBookkeeperHours),
            money(record.estimatedAccountantHours),
            money(record.estimatedCfoHours),
            typeof record.monthlyServiceTier === 'string' && record.monthlyServiceTier.trim()
              ? record.monthlyServiceTier
              : null,
            money(record.annualRate),
            Number.isFinite(annualBillingMonth) &&
            annualBillingMonth >= 1 &&
            annualBillingMonth <= 12
              ? Math.floor(annualBillingMonth)
              : null,
            record.lifecycleStage,
            record.cardPaymentsEnabled ?? false,
            normalizeTimeBreakdownMode(record.invoiceTimeBreakdownMode),
            record.invoiceTimeBreakdownAmounts === true,
            record.billToClientId ?? null,
            record.isBillingMaster === true,
            record.invoiceRecipientClientId ?? null,
          ],
        )
        await dbClient.query('commit')
      } catch (error) {
        await dbClient.query('rollback')
        throw error
      } finally {
        dbClient.release()
      }
      return record
    }

    const data = await readJson(localDataPath)
    if (!Array.isArray(data.clients)) data.clients = []
    if (data.clients.some((existing) => existing && existing.id === record.id)) return null

    // Same primary-contact resolution as the Postgres branch above (cardinal
    // rule 1) — created up front so the contact exists the moment the client
    // does, rather than appearing later via the backfill.
    if (!Array.isArray(data.contacts)) data.contacts = []
    const plan = planPrimaryContact({
      contacts: data.contacts,
      primaryContactId: client.primaryContactId,
      newPrimaryContact: client.newPrimaryContact,
      contactIds: record.contactIds,
    })
    let primaryContactId = plan.primaryContactId
    if (plan.create) {
      primaryContactId = `contact-${randomUUID().slice(0, 8)}`
      data.contacts = [{ id: primaryContactId, ...plan.create }, ...data.contacts]
    }
    record.contactIds = mergeContactIds(primaryContactId, plan.otherContactIds)
    record.contact = plan.contactName || record.contact

    data.clients = [record, ...data.clients]
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return record
  }

  async createChecklist(checklist) {
    await this._refuseBillingMasterWrite(checklist?.clientId, 'tasks')
    const nextChecklist = {
      ...checklist,
      id: checklist.id ?? `check-${randomUUID().slice(0, 8)}`,
      viewerIds: Array.isArray(checklist.viewerIds) ? checklist.viewerIds : [],
      editorIds: Array.isArray(checklist.editorIds) ? checklist.editorIds : [],
      caseId: checklist.caseId ?? checklist.id ?? `case-${randomUUID().slice(0, 8)}`,
      stageId: checklist.stageId ?? null,
      stageIndex: typeof checklist.stageIndex === 'number' ? checklist.stageIndex : 0,
      stageCount: typeof checklist.stageCount === 'number' ? checklist.stageCount : 1,
      ...(checklist.onboardingForClientId
        ? { onboardingForClientId: checklist.onboardingForClientId }
        : {}),
      items: checklist.items.map((item, index) => {
        const subItems = normalizeSubItems(item.subItems, { withDone: true })
        return {
          ...item,
          id: item.id ?? `item-${randomUUID().slice(0, 8)}`,
          // `done` is derived for items with sub-items (recursing sub-sub-items).
          done: subItems.length > 0 ? rollUpItemDone({ ...item, subItems }) : Boolean(item.done),
          sortOrder: index,
          dueDate: item.dueDate ?? null,
          assigneeId: item.assigneeId ?? null,
          subItems,
        }
      }),
    }
    if (!nextChecklist.caseId) {
      nextChecklist.caseId = nextChecklist.id
    }

    if (this.pool) {
      const client = await this.pool.connect()

      try {
        await client.query('begin')
        await client.query(
          `
            insert into checklists (id, title, client_id, assignee_id, template_id, frequency, due_date, viewer_ids, editor_ids, case_id, stage_id, stage_index, stage_count, category_id, onboarding_for_client_id, created_by, period_label, updated_at)
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())
          `,
          [
            nextChecklist.id,
            nextChecklist.title,
            nextChecklist.clientId,
            nextChecklist.assigneeId,
            nextChecklist.templateId ?? null,
            nextChecklist.frequency ?? null,
            nextChecklist.dueDate,
            nextChecklist.viewerIds,
            nextChecklist.editorIds,
            nextChecklist.caseId,
            nextChecklist.stageId,
            nextChecklist.stageIndex,
            nextChecklist.stageCount,
            nextChecklist.categoryId ? nextChecklist.categoryId : null,
            nextChecklist.onboardingForClientId ?? null,
            nextChecklist.createdBy ?? null,
            sanitizePeriodLabel(nextChecklist.periodLabel),
          ],
        )

        for (const item of nextChecklist.items) {
          await client.query(
            `
              insert into checklist_items (id, checklist_id, label, done, sort_order, due_date, due_day_of_month, assignee_id, waiting_on, waiting, waiting_for_checklist_id, waiting_ons, sub_items, completed_at, updated_at)
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, now())
            `,
            [
              item.id,
              nextChecklist.id,
              item.label,
              item.done,
              item.sortOrder,
              item.dueDate ?? null,
              typeof item.dueDayOfMonth === 'number' && item.dueDayOfMonth >= 1
                ? item.dueDayOfMonth
                : null,
              item.assigneeId ?? null,
              item.waitingOn ? String(item.waitingOn) : null,
              Boolean(item.waiting),
              item.waitingForChecklistId ? String(item.waitingForChecklistId) : null,
              JSON.stringify(normalizeWaitingOns(item.waitingOns)),
              JSON.stringify(Array.isArray(item.subItems) ? item.subItems : []),
              // Brand-new rows: a step that arrives already ticked was completed
              // now. Materialized template steps always arrive open, so this is
              // null on every ordinary create.
              preservedItemCompletion(item.done, undefined),
            ],
          )
        }

        await client.query('commit')
      } catch (error) {
        await client.query('rollback')
        throw error
      } finally {
        client.release()
      }

      return {
        ...nextChecklist,
        items: nextChecklist.items.map(({ sortOrder, ...item }) => item),
      }
    }

    const data = await readJson(localDataPath)
    data.checklists = [
      {
        ...nextChecklist,
        items: nextChecklist.items.map(({ sortOrder, ...item }) => item),
      },
      ...data.checklists,
    ]
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return data.checklists[0]
  }

  /**
   * Toggle a checklist item, or a sub-item when `subItemId` is given.
   *
   * - No `subItemId`/`subSubItemId`: toggle the item. If it has sub-items, all
   *   of them — and their sub-sub-items — are set to the new value and the
   *   item `done` is recomputed as the roll-up. Items with no sub-items toggle
   *   exactly as before.
   * - `subItemId` only: toggle that sub-item, cascading down to all its
   *   sub-sub-items, then recompute the top item.
   * - `subSubItemId` (with `subItemId`): toggle that sub-sub-item, recompute
   *   its parent sub-item, then the top item.
   *
   * Stored `done` flags are kept in sync at every level so every existing
   * `item.done` reader (progress, Gantt, stage hand-off) works unchanged.
   */
  async toggleChecklistItem(checklistId, itemId, subItemId, subSubItemId) {
    if (this.pool) {
      // Read-modify-write: roll-up can't be expressed as a single SQL update,
      // so load the item, mutate the JSONB, and persist atomically.
      const itemResult = await this.pool.query(
        `select id, done, sub_items from checklist_items where checklist_id = $1 and id = $2`,
        [checklistId, itemId],
      )
      if (!itemResult.rowCount) {
        return null
      }
      const row = itemResult.rows[0]
      const toggled = applyItemToggle(row.sub_items, row.done, { subItemId, subSubItemId })
      if (!toggled) return null

      await this.pool.query(
        `update checklist_items
         set done = $3, sub_items = $4::jsonb, ${completedAtClause(3)}, updated_at = now()
         where checklist_id = $1 and id = $2`,
        [checklistId, itemId, toggled.done, JSON.stringify(toggled.subItems)],
      )

      const data = await this.read()
      const updated = data.checklists.find((checklist) => checklist.id === checklistId) ?? null
      const spawn = await this.maybeSpawnNextStage(data, updated)
      // Onboarding case ↔ client lifecycle sync. No-op for normal cases (the
      // helper returns null unless `onboardingForClientId` is set), so ordinary
      // stage advancement is byte-for-byte unchanged.
      const lifecycleStage = onboardingStageForSync(updated, spawn)
      if (lifecycleStage && updated) {
        await this.setClientLifecycleStage(updated.onboardingForClientId, lifecycleStage)
      }
      return { checklist: updated, spawned: spawn }
    }

    const data = await readJson(localDataPath)
    let updatedChecklist = null
    let itemUpdated = false

    data.checklists = data.checklists.map((checklist) => {
      if (checklist.id !== checklistId) {
        return checklist
      }

      const items = checklist.items.map((item) => {
        if (item.id !== itemId) {
          return item
        }

        const toggled = applyItemToggle(item.subItems, item.done, { subItemId, subSubItemId })
        if (!toggled) return item
        itemUpdated = true
        // Keep flat items flat: only attach `subItems` when there are some.
        return toggled.subItems.length > 0
          ? withCompletionStamp({ ...item, subItems: toggled.subItems }, toggled.done)
          : withCompletionStamp(item, toggled.done)
      })

      if (!itemUpdated) {
        return checklist
      }

      updatedChecklist = {
        ...checklist,
        items,
      }

      return updatedChecklist
    })

    if (!updatedChecklist) {
      return null
    }

    // Auto-spawn next stage atomically with the toggle so the next assignee
    // sees the new live checklist on their next refetch.
    const spawn = await this.maybeSpawnNextStage(data, updatedChecklist, { fileMode: true })
    if (spawn) {
      data.checklists = sortChecklists([...data.checklists, spawn])
    }

    // Onboarding case ↔ client lifecycle sync, applied to the same open
    // snapshot so it persists atomically with the toggle. No-op for normal
    // cases (helper returns null without `onboardingForClientId`).
    const lifecycleStage = onboardingStageForSync(updatedChecklist, spawn)
    if (lifecycleStage) {
      data.clients = (data.clients ?? []).map((client) =>
        client.id === updatedChecklist.onboardingForClientId
          ? { ...client, lifecycleStage }
          : client,
      )
    }

    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return { checklist: updatedChecklist, spawned: spawn }
  }

  /**
   * If every item on `checklist` is done, this is the final stage's last toggle,
   * and there's a next stage on the parent template, materialise the next-stage
   * checklist. Guarded against double-spawn by checking for an existing
   * checklist with the same caseId+stageIndex+1. Returns the spawned checklist
   * (if any) or null.
   *
   * In Postgres mode the new checklist is inserted via the existing
   * createChecklist path so activity log + persistence are consistent. In file
   * mode the caller is expected to push the returned checklist into data and
   * persist (since we already hold the open data snapshot for that write).
   */
  async maybeSpawnNextStage(data, checklist, { fileMode = false } = {}) {
    if (!checklist || !Array.isArray(checklist.items) || checklist.items.length === 0) {
      return null
    }
    const allDone = checklist.items.every((item) => item.done)
    if (!allDone) return null
    if (!checklist.templateId) return null
    const stageCount = typeof checklist.stageCount === 'number' ? checklist.stageCount : 1
    const stageIndex = typeof checklist.stageIndex === 'number' ? checklist.stageIndex : 0
    if (stageIndex + 1 >= stageCount) return null

    const template = (data.checklistTemplates ?? []).find((t) => t.id === checklist.templateId)
    if (!template) return null
    const stages = Array.isArray(template.stages) && template.stages.length > 0
      ? template.stages
      : ensureTemplateStages(template).stages
    if (!stages || stageIndex + 1 >= stages.length) return null

    const caseId = checklist.caseId || checklist.id
    const alreadySpawned = (data.checklists ?? []).some(
      (entry) => entry.caseId === caseId && entry.stageIndex === stageIndex + 1,
    )
    if (alreadySpawned) return null

    const spawn = buildSpawnedNextStageChecklist({
      template: { ...template, stages },
      justCompletedChecklist: checklist,
    })
    if (!spawn) return null

    if (fileMode) {
      // Caller persists; just return the new instance.
      return spawn
    }

    // Postgres mode: insert via createChecklist so it goes through the same
    // path other instances do.
    const created = await this.createChecklist(spawn)
    // Auto-grant the new stage's assignee visibility into the client.
    await this.grantClientVisibility(created.clientId, created.assigneeId)
    return created
  }

  /**
   * Set a single client's `lifecycleStage`. Authoritative, server-side
   * counterpart of the manual-override the owner can set via the bulk save —
   * used by the onboarding case ↔ client sync so a stage advance moves the
   * client without a round-trip through the bulk app-data write, and by the
   * Mark inactive / Reactivate actions.
   *
   * Deliberately touches NOTHING else: no assignments, no plans, no templates,
   * no entries. Retiring a client is a single flag so that reactivating them
   * puts the workspace back exactly as it was.
   *
   * Returns the updated client, or null when the client doesn't exist or the
   * stage isn't a real one (an unknown stage is rejected outright here rather
   * than silently coerced to 'active', which would look like a successful
   * retirement that didn't happen).
   */
  async setClientLifecycleStage(clientId, lifecycleStage) {
    if (!clientId) return null
    if (!LIFECYCLE_STAGES.includes(lifecycleStage)) return null
    if (this.pool) {
      const result = await this.pool.query(
        `update clients set lifecycle_stage = $2, updated_at = now()
         where id = $1
         returning id`,
        [clientId, lifecycleStage],
      )
      if (!result.rowCount) return null
      const data = await this.read()
      return data.clients.find((client) => client.id === clientId) ?? null
    }

    const data = await readJson(localDataPath)
    let updated = null
    data.clients = (data.clients ?? []).map((client) => {
      if (client.id !== clientId) return client
      updated = { ...client, lifecycleStage }
      return updated
    })
    if (!updated) return null
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return updated
  }

  /**
   * Owner action — begin a client's onboarding. Creates the ONE onboarding
   * checklist as a 3-stage case (Proposal → Onboarding → Client), tags the
   * template with `onboardingForClientId` so each stage syncs the client's
   * lifecycle stage, materialises the Stage-1 (Proposal) instance, and moves
   * the client to 'proposal'. Reuses the standard template + generate paths
   * (no parallel creation path). Returns { template, checklist, client } or
   * null when the client is missing or already has an onboarding case.
   * Owner-only — caller enforces auth.
   */
  async startOnboarding(clientId) {
    const data = await this.read()
    const client = (data.clients ?? []).find((c) => c.id === clientId)
    if (!client) return null
    // Idempotent: don't open a second onboarding case for the same client.
    const existing = (data.checklistTemplates ?? []).find(
      (t) => t.onboardingForClientId === clientId,
    )
    if (existing) return null

    const assigneeId = (client.assignedBookkeeperIds ?? [])[0] || ''
    const today = formatDateOnly(new Date())
    const makeStage = (name, items) => ({
      id: `stage-${randomUUID().slice(0, 8)}`,
      name,
      assigneeId,
      offsetDays: 0,
      viewerIds: [],
      editorIds: [],
      items: items.map((label) => ({
        id: `template-item-${randomUUID().slice(0, 8)}`,
        label,
      })),
    })
    const template = {
      id: `template-${randomUUID().slice(0, 8)}`,
      title: `Onboarding · ${client.name}`,
      clientId,
      assigneeId,
      frequency: 'monthly',
      nextDueDate: today,
      // Not a recurring template — it's a one-shot case. Inactive so the
      // materializer never spawns extra instances from it.
      active: false,
      isStandard: false,
      onboardingForClientId: clientId,
      viewerIds: [],
      editorIds: [],
      stages: [
        makeStage('Proposal', [
          'Send proposal / engagement letter',
          'Confirm scope & pricing',
          'Client signs engagement',
        ]),
        makeStage('Onboarding', [
          'Collect access to books / bank feeds',
          'Set up client in systems',
          'Gather prior financials',
        ]),
        makeStage('Client', [
          'Kickoff call complete',
          'First close / deliverable scheduled',
          'Mark client active',
        ]),
      ],
    }

    const nextData = {
      ...data,
      checklistTemplates: [...(data.checklistTemplates ?? []), template],
      clients: (data.clients ?? []).map((c) =>
        c.id === clientId ? { ...c, lifecycleStage: 'proposal' } : c,
      ),
    }
    await this.write(nextData)

    // Materialise the Stage-1 (Proposal) instance via the shared generate path
    // so it goes through createChecklist + visibility grant like every other
    // instance. It inherits `onboardingForClientId` from the template.
    const checklist = await this.generateChecklistFromTemplate(template.id, { dueDate: today })
    const refreshed = await this.read()
    const updatedClient = (refreshed.clients ?? []).find((c) => c.id === clientId) ?? null
    return { template, checklist, client: updatedClient }
  }

  async setChecklistViewers(checklistId, viewerIds, editorIds) {
    const safeViewerIds = Array.isArray(viewerIds) ? [...new Set(viewerIds)] : []
    const safeEditorIds = Array.isArray(editorIds)
      ? [...new Set(editorIds)].filter((id) => safeViewerIds.includes(id))
      : []

    if (this.pool) {
      const result = await this.pool.query(
        `
          update checklists
          set viewer_ids = $2,
              editor_ids = $3,
              updated_at = now()
          where id = $1 and deleted_at is null
          returning id
        `,
        [checklistId, safeViewerIds, safeEditorIds],
      )

      if (!result.rowCount) {
        return null
      }

      const data = await this.read()
      return data.checklists.find((checklist) => checklist.id === checklistId) ?? null
    }

    const data = await readJson(localDataPath)
    let updatedChecklist = null
    data.checklists = data.checklists.map((checklist) => {
      if (checklist.id !== checklistId) {
        return checklist
      }

      updatedChecklist = {
        ...checklist,
        viewerIds: safeViewerIds,
        editorIds: safeEditorIds,
      }
      return updatedChecklist
    })

    if (!updatedChecklist) {
      return null
    }

    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return updatedChecklist
  }

  async setChecklistTemplateViewers(templateId, viewerIds, editorIds) {
    const safeViewerIds = Array.isArray(viewerIds) ? [...new Set(viewerIds)] : []
    const safeEditorIds = Array.isArray(editorIds)
      ? [...new Set(editorIds)].filter((id) => safeViewerIds.includes(id))
      : []

    if (this.pool) {
      const result = await this.pool.query(
        `
          update checklist_templates
          set viewer_ids = $2,
              editor_ids = $3,
              updated_at = now()
          where id = $1
          returning id
        `,
        [templateId, safeViewerIds, safeEditorIds],
      )

      if (!result.rowCount) {
        return null
      }

      const data = await this.read()
      return data.checklistTemplates.find((template) => template.id === templateId) ?? null
    }

    const data = await readJson(localDataPath)
    let updatedTemplate = null
    data.checklistTemplates = (data.checklistTemplates ?? []).map((template) => {
      if (template.id !== templateId) {
        return template
      }

      updatedTemplate = {
        ...template,
        viewerIds: safeViewerIds,
        editorIds: safeEditorIds,
      }
      return updatedTemplate
    })

    if (!updatedTemplate) {
      return null
    }

    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return updatedTemplate
  }

  /**
   * Switch a recurring checklist template on or off.
   *
   * A switched-off template is one of the two historical causes of "my
   * recurring checklist just stopped appearing" — the materializer skips it
   * silently. Turning it back on is the reversible, visible fix, so it is the
   * one config change the assistant is allowed to propose (behind the owner's
   * confirm card). Returns the updated template, or null when the id is
   * unknown. Targeted single-row update in Postgres; same field on the JSON
   * backend.
   */
  async setChecklistTemplateActive(templateId, active) {
    const nextActive = Boolean(active)

    if (this.pool) {
      const result = await this.pool.query(
        `
          update checklist_templates
          set active = $2,
              updated_at = now()
          where id = $1
          returning id
        `,
        [templateId, nextActive],
      )

      if (!result.rowCount) {
        return null
      }

      const data = await this.read()
      return data.checklistTemplates.find((template) => template.id === templateId) ?? null
    }

    const data = await readJson(localDataPath)
    let updatedTemplate = null
    data.checklistTemplates = (data.checklistTemplates ?? []).map((template) => {
      if (template.id !== templateId) {
        return template
      }

      updatedTemplate = { ...template, active: nextActive }
      return updatedTemplate
    })

    if (!updatedTemplate) {
      return null
    }

    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return updatedTemplate
  }

  async reorderChecklistItems(checklistId, orderedIds) {
    if (this.pool) {
      // Update sort_order for each item using a CASE expression
      if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
        return null
      }
      const cases = orderedIds.map((id, idx) => `when id = $${idx + 2} then ${idx}`).join(' ')
      const params = [checklistId, ...orderedIds]
      const result = await this.pool.query(
        `
          update checklist_items
          set sort_order = case ${cases} end,
              updated_at = now()
          where checklist_id = $1 and id = any($${params.length + 1}::text[])
          returning checklist_id
        `,
        [...params, orderedIds],
      )
      if (!result.rowCount) {
        return null
      }
      const data = await this.read()
      return data.checklists.find((checklist) => checklist.id === checklistId) ?? null
    }

    const data = await readJson(localDataPath)
    let updatedChecklist = null
    data.checklists = data.checklists.map((checklist) => {
      if (checklist.id !== checklistId) {
        return checklist
      }
      const byId = new Map(checklist.items.map((item) => [item.id, item]))
      const reordered = orderedIds.map((id) => byId.get(id)).filter(Boolean)
      const seen = new Set(orderedIds)
      const tail = checklist.items.filter((item) => !seen.has(item.id))
      updatedChecklist = { ...checklist, items: [...reordered, ...tail] }
      return updatedChecklist
    })
    if (!updatedChecklist) {
      return null
    }
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return updatedChecklist
  }

  async appendChecklistItems(checklistId, labels) {
    if (!Array.isArray(labels) || labels.length === 0) {
      return null
    }
    if (this.pool) {
      // Find current max sort_order
      const sortResult = await this.pool.query(
        `select coalesce(max(sort_order), -1) as max_order from checklist_items where checklist_id = $1`,
        [checklistId],
      )
      let nextOrder = (sortResult.rows[0]?.max_order ?? -1) + 1

      // Verify checklist exists
      const checkResult = await this.pool.query(
        `select id from checklists where id = $1 and deleted_at is null`,
        [checklistId],
      )
      if (!checkResult.rowCount) {
        return null
      }

      for (const label of labels) {
        const id = `item-${randomUUID().slice(0, 8)}`
        await this.pool.query(
          `insert into checklist_items (id, checklist_id, label, done, sort_order, created_at, updated_at)
           values ($1, $2, $3, false, $4, now(), now())`,
          [id, checklistId, label, nextOrder],
        )
        nextOrder += 1
      }

      const data = await this.read()
      return data.checklists.find((checklist) => checklist.id === checklistId) ?? null
    }

    const data = await readJson(localDataPath)
    let updatedChecklist = null
    data.checklists = data.checklists.map((checklist) => {
      if (checklist.id !== checklistId) {
        return checklist
      }
      const newItems = labels.map((label) => ({
        id: `item-${randomUUID().slice(0, 8)}`,
        label,
        done: false,
      }))
      updatedChecklist = { ...checklist, items: [...checklist.items, ...newItems] }
      return updatedChecklist
    })
    if (!updatedChecklist) {
      return null
    }
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return updatedChecklist
  }

  async updateChecklistItem(checklistId, itemId, patch) {
    const { title, dueDate, assigneeId, waitingOn, waiting, waitingForChecklistId } = patch ?? {}

    if (this.pool) {
      const setClauses = []
      const params = [checklistId, itemId]

      if (title !== undefined) {
        params.push(title)
        setClauses.push(`label = $${params.length}`)
      }
      if (dueDate !== undefined) {
        params.push(dueDate === '' || dueDate === null ? null : dueDate)
        setClauses.push(`due_date = $${params.length}`)
      }
      if (assigneeId !== undefined) {
        params.push(assigneeId === '' || assigneeId === null ? null : assigneeId)
        setClauses.push(`assignee_id = $${params.length}`)
      }
      if (waitingOn !== undefined) {
        params.push(waitingOn === '' || waitingOn === null ? null : String(waitingOn))
        setClauses.push(`waiting_on = $${params.length}`)
      }
      if (waiting !== undefined) {
        params.push(Boolean(waiting))
        setClauses.push(`waiting = $${params.length}`)
      }
      if (waitingForChecklistId !== undefined) {
        params.push(
          waitingForChecklistId === '' || waitingForChecklistId === null
            ? null
            : String(waitingForChecklistId),
        )
        setClauses.push(`waiting_for_checklist_id = $${params.length}`)
      }

      if (setClauses.length === 0) {
        const data = await this.read()
        return data.checklists.find((checklist) => checklist.id === checklistId) ?? null
      }

      setClauses.push('updated_at = now()')
      const result = await this.pool.query(
        `update checklist_items set ${setClauses.join(', ')} where checklist_id = $1 and id = $2 returning id`,
        params,
      )
      if (!result.rowCount) {
        return null
      }
      const data = await this.read()
      return data.checklists.find((checklist) => checklist.id === checklistId) ?? null
    }

    const data = await readJson(localDataPath)
    let updatedChecklist = null
    let itemFound = false
    data.checklists = data.checklists.map((checklist) => {
      if (checklist.id !== checklistId) {
        return checklist
      }
      const items = checklist.items.map((item) => {
        if (item.id !== itemId) {
          return item
        }
        itemFound = true
        const next = { ...item }
        if (title !== undefined) {
          next.label = title
        }
        if (dueDate !== undefined) {
          if (dueDate === '' || dueDate === null) {
            delete next.dueDate
          } else {
            next.dueDate = dueDate
          }
        }
        if (assigneeId !== undefined) {
          if (assigneeId === '' || assigneeId === null) {
            delete next.assigneeId
          } else {
            next.assigneeId = assigneeId
          }
        }
        if (waitingOn !== undefined) {
          if (waitingOn === '' || waitingOn === null) {
            delete next.waitingOn
          } else {
            next.waitingOn = String(waitingOn)
          }
        }
        if (waiting !== undefined) {
          if (waiting) {
            next.waiting = true
          } else {
            delete next.waiting
          }
        }
        if (waitingForChecklistId !== undefined) {
          if (waitingForChecklistId === '' || waitingForChecklistId === null) {
            delete next.waitingForChecklistId
          } else {
            next.waitingForChecklistId = String(waitingForChecklistId)
          }
        }
        return next
      })
      updatedChecklist = { ...checklist, items }
      return updatedChecklist
    })
    if (!itemFound || !updatedChecklist) {
      return null
    }
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return updatedChecklist
  }

  async deleteChecklistItem(checklistId, itemId) {
    if (this.pool) {
      const result = await this.pool.query(
        `delete from checklist_items where checklist_id = $1 and id = $2 returning id`,
        [checklistId, itemId],
      )
      if (!result.rowCount) {
        return null
      }
      const data = await this.read()
      return data.checklists.find((checklist) => checklist.id === checklistId) ?? null
    }

    const data = await readJson(localDataPath)
    let updatedChecklist = null
    let itemFound = false
    data.checklists = data.checklists.map((checklist) => {
      if (checklist.id !== checklistId) {
        return checklist
      }
      const items = checklist.items.filter((item) => {
        if (item.id === itemId) {
          itemFound = true
          return false
        }
        return true
      })
      updatedChecklist = { ...checklist, items }
      return updatedChecklist
    })
    if (!itemFound || !updatedChecklist) {
      return null
    }
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return updatedChecklist
  }

  /**
   * Delete an entire checklist by id. Owner-gated at the server boundary.
   * In Postgres mode the `checklist_items` FK has `on delete cascade`, so a
   * single DELETE removes the parent row and all of its items together.
   * Time entries that reference items via `task_id` are deliberately
   * preserved — billing history must survive a task cleanup — and become
   * dangling references that the UI already handles as "unknown task."
   * Returns the deleted checklist id, or `null` when no row matched.
   */
  /**
   * Soft-delete a checklist — move it to the recycle bin without losing data.
   * Server-side this just stamps `deleted_at = now()`; `read()` then sorts the
   * row into `data.recycledChecklists`. Items stay attached (the FK cascade
   * only fires on a real DELETE, which happens when the bin is emptied), so
   * a restore brings everything back exactly as it was. Returns the deleted
   * row's id, `null` when no active row matched (already deleted or unknown).
   */
  async deleteChecklist(checklistId) {
    if (this.pool) {
      const result = await this.pool.query(
        `update checklists set deleted_at = now() where id = $1 and deleted_at is null returning id`,
        [checklistId],
      )
      return result.rowCount ? checklistId : null
    }

    const data = await readJson(localDataPath)
    const target = data.checklists.find((checklist) => checklist.id === checklistId)
    if (!target) return null
    const deletedAt = nowIso()
    data.checklists = data.checklists.filter((checklist) => checklist.id !== checklistId)
    data.recycledChecklists = Array.isArray(data.recycledChecklists) ? data.recycledChecklists : []
    data.recycledChecklists.push({ ...target, deletedAt })
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return checklistId
  }

  /**
   * Flag an ACTIVE checklist as having a pending deletion request from a
   * non-owner. Stamps `deletion_requested_by`/`deletion_requested_at` without
   * touching `deleted_at` — the checklist stays active until an owner approves
   * (deleteChecklist) or rejects (clearChecklistDeletionRequest). Returns the
   * updated checklist object, or `null` when no active row matched.
   */
  async requestChecklistDeletion(checklistId, userId) {
    if (this.pool) {
      const result = await this.pool.query(
        `update checklists set deletion_requested_by = $2, deletion_requested_at = now()
         where id = $1 and deleted_at is null returning id`,
        [checklistId, userId],
      )
      if (!result.rowCount) return null
      const fresh = await this.read()
      return fresh.checklists.find((checklist) => checklist.id === checklistId) ?? null
    }

    const data = await readJson(localDataPath)
    const target = data.checklists.find((checklist) => checklist.id === checklistId)
    if (!target) return null
    target.deletionRequestedBy = userId
    target.deletionRequestedAt = nowIso()
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return target
  }

  /**
   * Clear a pending deletion request (owner rejected it). Wipes both
   * `deletion_requested_*` columns and returns the updated checklist, or
   * `null` when no active row matched.
   */
  async clearChecklistDeletionRequest(checklistId) {
    if (this.pool) {
      const result = await this.pool.query(
        `update checklists set deletion_requested_by = null, deletion_requested_at = null
         where id = $1 and deleted_at is null returning id`,
        [checklistId],
      )
      if (!result.rowCount) return null
      const fresh = await this.read()
      return fresh.checklists.find((checklist) => checklist.id === checklistId) ?? null
    }

    const data = await readJson(localDataPath)
    const target = data.checklists.find((checklist) => checklist.id === checklistId)
    if (!target) return null
    target.deletionRequestedBy = null
    target.deletionRequestedAt = null
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return target
  }

  /**
   * Restore a soft-deleted checklist from the recycle bin. Clears `deleted_at`
   * and returns the freshly-active checklist object so the caller can drop it
   * straight back into the active list. Returns `null` when there's no
   * matching recycled row (already restored, never deleted, or wrong id).
   */
  async restoreChecklist(checklistId) {
    if (this.pool) {
      const result = await this.pool.query(
        `update checklists set deleted_at = null where id = $1 and deleted_at is not null returning id`,
        [checklistId],
      )
      if (!result.rowCount) return null
      const fresh = await this.read()
      return fresh.checklists.find((checklist) => checklist.id === checklistId) ?? null
    }

    const data = await readJson(localDataPath)
    const recycled = Array.isArray(data.recycledChecklists) ? data.recycledChecklists : []
    const target = recycled.find((checklist) => checklist.id === checklistId)
    if (!target) return null
    data.recycledChecklists = recycled.filter((checklist) => checklist.id !== checklistId)
    const { deletedAt: _deletedAt, ...rest } = target
    const restored = { ...rest, deletedAt: null }
    data.checklists = Array.isArray(data.checklists) ? [...data.checklists, restored] : [restored]
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return restored
  }

  /**
   * Permanently delete every checklist in the recycle bin. Postgres mode lets
   * the `checklist_items` FK cascade clean up the per-item rows. Time entries
   * referencing the removed items via `task_id` are preserved because that
   * column has no FK — billing history must survive. Returns the count of
   * checklists that were purged so the caller can show meaningful feedback.
   */
  async emptyChecklistRecycleBin() {
    if (this.pool) {
      const result = await this.pool.query(
        `delete from checklists where deleted_at is not null returning id`,
      )
      return result.rowCount ?? 0
    }

    const data = await readJson(localDataPath)
    const recycled = Array.isArray(data.recycledChecklists) ? data.recycledChecklists : []
    const removed = recycled.length
    if (removed === 0) return 0
    data.recycledChecklists = []
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return removed
  }

  /**
   * One-shot maintenance: set a user's email address by id. Used to
   * restore real email addresses after the bulk-save bug overwrote them
   * with the synthetic `${id}@pbj.local` placeholder. Touches ONLY the
   * email column — password, 2FA secret, backup codes, sessions, and
   * every FK on user_id all stay intact (user_id is the primary key
   * everything else attaches to).
   *
   * Returns the user id when updated, or `null` if no row matched.
   */
  async setUserEmail(userId, email) {
    if (this.pool) {
      const result = await this.pool.query(
        `update users set email = $2, updated_at = now() where id = $1 returning id`,
        [userId, String(email).trim()],
      )
      return result.rowCount ? userId : null
    }
    return null
  }

  /**
   * One-shot maintenance: hard-delete every checklist, checklist-template,
   * reimbursement, recurring-reimbursement, time-entry, and client-assignment
   * whose `client_id` points to a client that no longer exists in the DB.
   * These rows accumulate when a client deletion finishes server-side (the FK
   * cascade fires) before the client's in-memory cascade has rewritten the
   * dependent state — or when an earlier autosave failed mid-flight and left
   * dangling refs. They're invisible to the cascade because the parent client
   * is already gone, but the bulk-save filter keeps DROPPING them on every
   * subsequent save (correctly — there's nothing to attach them to), which
   * makes the user-visible delete attempts feel like they "never stick."
   *
   * Returns the counts of removed rows so the caller can show feedback.
   */
  async cleanupOrphanedClientData() {
    if (this.pool) {
      const client = await this.pool.connect()
      try {
        await client.query('begin')
        const checklistItemsResult = await client.query(`
          delete from checklist_items
          where checklist_id in (
            select id from checklists where client_id not in (select id from clients)
          )
        `)
        const checklistsResult = await client.query(
          `delete from checklists where client_id not in (select id from clients)`,
        )
        const templateItemsResult = await client.query(`
          delete from checklist_template_items
          where template_id in (
            select id from checklist_templates
            where client_id is not null and client_id not in (select id from clients)
          )
        `)
        const templateStagesResult = await client.query(`
          delete from checklist_template_stages
          where template_id in (
            select id from checklist_templates
            where client_id is not null and client_id not in (select id from clients)
          )
        `)
        const templatesResult = await client.query(`
          delete from checklist_templates
          where client_id is not null and client_id not in (select id from clients)
        `)
        const reimbursementsResult = await client.query(
          `delete from reimbursements where client_id not in (select id from clients)`,
        )
        const recurringResult = await client.query(
          `delete from recurring_reimbursements where client_id not in (select id from clients)`,
        )
        const timeEntriesResult = await client.query(
          `delete from time_entries where client_id not in (select id from clients)`,
        )
        const assignmentsResult = await client.query(
          `delete from client_assignments where client_id not in (select id from clients)`,
        )
        await client.query('commit')
        return {
          checklists: checklistsResult.rowCount ?? 0,
          checklistItems: checklistItemsResult.rowCount ?? 0,
          checklistTemplates: templatesResult.rowCount ?? 0,
          checklistTemplateItems: templateItemsResult.rowCount ?? 0,
          checklistTemplateStages: templateStagesResult.rowCount ?? 0,
          reimbursements: reimbursementsResult.rowCount ?? 0,
          recurringReimbursements: recurringResult.rowCount ?? 0,
          timeEntries: timeEntriesResult.rowCount ?? 0,
          clientAssignments: assignmentsResult.rowCount ?? 0,
        }
      } catch (error) {
        await client.query('rollback')
        throw error
      } finally {
        client.release()
      }
    }

    // File-fallback mode: filter the in-memory shape against `data.clients`.
    const data = await readJson(localDataPath)
    const validClientIds = new Set(
      Array.isArray(data.clients) ? data.clients.map((c) => c.id) : [],
    )
    const isOrphan = (row) => row && row.clientId && !validClientIds.has(row.clientId)
    const orphanFilter = (rows) => (Array.isArray(rows) ? rows.filter((r) => !isOrphan(r)) : [])
    const asArray = (rows) => (Array.isArray(rows) ? rows : [])

    // Store-8: COUNT THE SAME TABLES THE POSTGRES BRANCH COUNTS. This used to
    // report 0 for seven of the nine keys — the return shape matched, the
    // numbers did not, so the same fixture told two different stories depending
    // on which backend answered. Telemetry only (nothing branches on these),
    // but a diagnostic that quietly says "nothing was orphaned" is worse than
    // no diagnostic.
    //
    // The mapping from tables to the file shape:
    //   checklist_items            → items nested on each dropped checklist
    //   checklist_template_items   → items nested on each dropped template's
    //   checklist_template_stages    stages (`ensureTemplateStages` migrates a
    //                                legacy flat `items` list into a synthetic
    //                                stage 1, exactly as the insert does — so a
    //                                template written either way counts the same)
    //   client_assignments         → no such array on this backend. It stays 0,
    //                                and that is the honest answer: the file
    //                                backend has nothing to delete. (The pg
    //                                table is inert too — batch 2 removes it.)
    //
    // Recycled checklists count under `checklists`, matching Postgres, where
    // the bin is rows in `checklists` carrying a `deleted_at` rather than a
    // table of its own.
    const droppedChecklists = asArray(data.checklists).filter(isOrphan)
    const droppedRecycled = asArray(data.recycledChecklists).filter(isOrphan)
    const droppedTemplates = asArray(data.checklistTemplates).filter(
      (t) => t && t.clientId && !validClientIds.has(t.clientId),
    )
    const countNested = (rows, get) =>
      rows.reduce((total, row) => total + asArray(get(row)).length, 0)
    const droppedTemplateStages = droppedTemplates.flatMap(
      (t) => ensureTemplateStages(t).stages ?? [],
    )

    const counts = {
      checklists: droppedChecklists.length + droppedRecycled.length,
      checklistItems: countNested([...droppedChecklists, ...droppedRecycled], (c) => c.items),
      checklistTemplates: droppedTemplates.length,
      checklistTemplateItems: countNested(droppedTemplateStages, (stage) => stage.items),
      checklistTemplateStages: droppedTemplateStages.length,
      reimbursements: asArray(data.reimbursements).filter(isOrphan).length,
      recurringReimbursements: asArray(data.recurringReimbursements).filter(isOrphan).length,
      timeEntries: asArray(data.timeEntries).filter(isOrphan).length,
      clientAssignments: 0,
    }

    data.checklists = orphanFilter(data.checklists)
    data.recycledChecklists = orphanFilter(data.recycledChecklists)
    data.checklistTemplates = asArray(data.checklistTemplates).filter(
      (t) => !t || !t.clientId || validClientIds.has(t.clientId),
    )
    data.reimbursements = orphanFilter(data.reimbursements)
    data.recurringReimbursements = orphanFilter(data.recurringReimbursements)
    data.timeEntries = orphanFilter(data.timeEntries)
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return counts
  }

  /**
   * Add a sub-item (one nested level) under a checklist item. The new sub-item
   * starts `done: false`, which makes a previously-complete parent incomplete —
   * so the parent `done` roll-up is recomputed and persisted. Returns the
   * updated checklist or null when the item is not found.
   */
  async addChecklistSubItem(checklistId, itemId, title) {
    const trimmed = typeof title === 'string' ? title.trim() : ''
    if (!trimmed) return null

    if (this.pool) {
      const itemResult = await this.pool.query(
        `select sub_items from checklist_items where checklist_id = $1 and id = $2`,
        [checklistId, itemId],
      )
      if (!itemResult.rowCount) return null
      const subItems = normalizeSubItems(itemResult.rows[0].sub_items, { withDone: true })
      const nextSubItems = [
        ...subItems,
        { id: `subitem-${randomUUID().slice(0, 8)}`, title: trimmed, done: false },
      ]
      await this.pool.query(
        `update checklist_items
         set sub_items = $3::jsonb, done = $4, ${completedAtClause(4)}, updated_at = now()
         where checklist_id = $1 and id = $2`,
        [checklistId, itemId, JSON.stringify(nextSubItems), nextSubItems.every((sub) => sub.done)],
      )
      const data = await this.read()
      return data.checklists.find((checklist) => checklist.id === checklistId) ?? null
    }

    const data = await readJson(localDataPath)
    let updatedChecklist = null
    let itemFound = false
    data.checklists = data.checklists.map((checklist) => {
      if (checklist.id !== checklistId) return checklist
      const items = checklist.items.map((item) => {
        if (item.id !== itemId) return item
        itemFound = true
        const subItems = normalizeSubItems(item.subItems, { withDone: true })
        const nextSubItems = [
          ...subItems,
          { id: `subitem-${randomUUID().slice(0, 8)}`, title: trimmed, done: false },
        ]
        return withCompletionStamp(
          { ...item, subItems: nextSubItems },
          nextSubItems.every((sub) => sub.done),
        )
      })
      updatedChecklist = { ...checklist, items }
      return updatedChecklist
    })
    if (!itemFound || !updatedChecklist) return null
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return updatedChecklist
  }

  /**
   * Remove a sub-item from a checklist item, then recompute the parent `done`
   * roll-up (removing the last incomplete sub-item can complete the parent;
   * removing every sub-item makes the parent a flat item again). Returns the
   * updated checklist or null when the item / sub-item is not found.
   */
  async removeChecklistSubItem(checklistId, itemId, subItemId) {
    if (this.pool) {
      const itemResult = await this.pool.query(
        `select done, sub_items from checklist_items where checklist_id = $1 and id = $2`,
        [checklistId, itemId],
      )
      if (!itemResult.rowCount) return null
      const subItems = normalizeSubItems(itemResult.rows[0].sub_items, { withDone: true })
      if (!subItems.some((sub) => sub.id === subItemId)) return null
      const nextSubItems = subItems.filter((sub) => sub.id !== subItemId)
      // With sub-items the parent is the roll-up; with none left, keep its
      // current stored `done`.
      const nextDone =
        nextSubItems.length > 0
          ? nextSubItems.every((sub) => sub.done)
          : Boolean(itemResult.rows[0].done)
      await this.pool.query(
        `update checklist_items
         set sub_items = $3::jsonb, done = $4, ${completedAtClause(4)}, updated_at = now()
         where checklist_id = $1 and id = $2`,
        [checklistId, itemId, JSON.stringify(nextSubItems), nextDone],
      )
      const data = await this.read()
      return data.checklists.find((checklist) => checklist.id === checklistId) ?? null
    }

    const data = await readJson(localDataPath)
    let updatedChecklist = null
    let subItemFound = false
    data.checklists = data.checklists.map((checklist) => {
      if (checklist.id !== checklistId) return checklist
      const items = checklist.items.map((item) => {
        if (item.id !== itemId) return item
        const subItems = normalizeSubItems(item.subItems, { withDone: true })
        if (!subItems.some((sub) => sub.id === subItemId)) return item
        subItemFound = true
        const nextSubItems = subItems.filter((sub) => sub.id !== subItemId)
        const nextDone =
          nextSubItems.length > 0
            ? nextSubItems.every((sub) => sub.done)
            : Boolean(item.done)
        return withCompletionStamp({ ...item, subItems: nextSubItems }, nextDone)
      })
      updatedChecklist = { ...checklist, items }
      return updatedChecklist
    })
    if (!subItemFound || !updatedChecklist) return null
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return updatedChecklist
  }

  /**
   * Patch a sub-item's "waiting on" flag + note (the only editable sub-item
   * fields on a live checklist). Rewrites the parent item's `sub_items` JSONB.
   * `waiting` toggles the blocked flag; `waitingOn` is the free-text note
   * (empty/null clears it). Returns the updated checklist or null when not found.
   */
  async updateChecklistSubItem(checklistId, itemId, subItemId, patch) {
    const { waiting, waitingOn, waitingForChecklistId } = patch ?? {}
    const applyPatch = (sub) => {
      const next = { ...sub }
      if (waiting !== undefined) {
        if (waiting) next.waiting = true
        else delete next.waiting
      }
      if (waitingOn !== undefined) {
        if (waitingOn === '' || waitingOn === null) delete next.waitingOn
        else next.waitingOn = String(waitingOn)
      }
      if (waitingForChecklistId !== undefined) {
        if (waitingForChecklistId === '' || waitingForChecklistId === null) {
          delete next.waitingForChecklistId
        } else {
          next.waitingForChecklistId = String(waitingForChecklistId)
        }
      }
      return next
    }

    if (this.pool) {
      const itemResult = await this.pool.query(
        `select sub_items from checklist_items where checklist_id = $1 and id = $2`,
        [checklistId, itemId],
      )
      if (!itemResult.rowCount) return null
      const subItems = normalizeSubItems(itemResult.rows[0].sub_items, { withDone: true })
      if (!subItems.some((sub) => sub.id === subItemId)) return null
      const nextSubItems = subItems.map((sub) => (sub.id === subItemId ? applyPatch(sub) : sub))
      await this.pool.query(
        `update checklist_items set sub_items = $3::jsonb, updated_at = now()
         where checklist_id = $1 and id = $2`,
        [checklistId, itemId, JSON.stringify(nextSubItems)],
      )
      const data = await this.read()
      return data.checklists.find((checklist) => checklist.id === checklistId) ?? null
    }

    const data = await readJson(localDataPath)
    let updatedChecklist = null
    let subItemFound = false
    data.checklists = data.checklists.map((checklist) => {
      if (checklist.id !== checklistId) return checklist
      const items = checklist.items.map((item) => {
        if (item.id !== itemId) return item
        const subItems = normalizeSubItems(item.subItems, { withDone: true })
        if (!subItems.some((sub) => sub.id === subItemId)) return item
        subItemFound = true
        const nextSubItems = subItems.map((sub) =>
          sub.id === subItemId ? applyPatch(sub) : sub,
        )
        return { ...item, subItems: nextSubItems }
      })
      updatedChecklist = { ...checklist, items }
      return updatedChecklist
    })
    if (!subItemFound || !updatedChecklist) return null
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return updatedChecklist
  }

  /**
   * Add a sub-sub-item (the deepest level) under a sub-item of a checklist
   * item. The new sub-sub-item starts `done: false`, which can make a
   * previously-complete sub-item — and the top item — incomplete, so both
   * `done` roll-ups are recomputed and persisted. Returns the updated
   * checklist or null when the item / sub-item is not found.
   */
  async addChecklistSubSubItem(checklistId, itemId, subItemId, title) {
    const trimmed = typeof title === 'string' ? title.trim() : ''
    if (!trimmed) return null

    if (this.pool) {
      const itemResult = await this.pool.query(
        `select sub_items from checklist_items where checklist_id = $1 and id = $2`,
        [checklistId, itemId],
      )
      if (!itemResult.rowCount) return null
      const subItems = normalizeSubItems(itemResult.rows[0].sub_items, { withDone: true })
      if (!subItems.some((sub) => sub.id === subItemId)) return null
      const nextSubItems = subItems.map((sub) => {
        if (sub.id !== subItemId) return sub
        const subSubItems = normalizeSubSubItems(sub.subItems, { withDone: true })
        const nextSubSubItems = [
          ...subSubItems,
          { id: `subsubitem-${randomUUID().slice(0, 8)}`, title: trimmed, done: false },
        ]
        return {
          ...sub,
          subItems: nextSubSubItems,
          done: nextSubSubItems.every((subSub) => subSub.done),
        }
      })
      await this.pool.query(
        `update checklist_items
         set sub_items = $3::jsonb, done = $4, ${completedAtClause(4)}, updated_at = now()
         where checklist_id = $1 and id = $2`,
        [checklistId, itemId, JSON.stringify(nextSubItems), nextSubItems.every((sub) => sub.done)],
      )
      const data = await this.read()
      return data.checklists.find((checklist) => checklist.id === checklistId) ?? null
    }

    const data = await readJson(localDataPath)
    let updatedChecklist = null
    let subItemFound = false
    data.checklists = data.checklists.map((checklist) => {
      if (checklist.id !== checklistId) return checklist
      const items = checklist.items.map((item) => {
        if (item.id !== itemId) return item
        const subItems = normalizeSubItems(item.subItems, { withDone: true })
        if (!subItems.some((sub) => sub.id === subItemId)) return item
        subItemFound = true
        const nextSubItems = subItems.map((sub) => {
          if (sub.id !== subItemId) return sub
          const subSubItems = normalizeSubSubItems(sub.subItems, { withDone: true })
          const nextSubSubItems = [
            ...subSubItems,
            { id: `subsubitem-${randomUUID().slice(0, 8)}`, title: trimmed, done: false },
          ]
          return {
            ...sub,
            subItems: nextSubSubItems,
            done: nextSubSubItems.every((subSub) => subSub.done),
          }
        })
        return withCompletionStamp(
          { ...item, subItems: nextSubItems },
          nextSubItems.every((sub) => sub.done),
        )
      })
      updatedChecklist = { ...checklist, items }
      return updatedChecklist
    })
    if (!subItemFound || !updatedChecklist) return null
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return updatedChecklist
  }

  /**
   * Remove a sub-sub-item from a sub-item, then recompute the sub-item's `done`
   * roll-up and the top item's `done` (removing the last incomplete
   * sub-sub-item can complete the sub-item; removing all of them makes the
   * sub-item a flat sub-item again). Returns the updated checklist or null when
   * the item / sub-item / sub-sub-item is not found.
   */
  async removeChecklistSubSubItem(checklistId, itemId, subItemId, subSubItemId) {
    if (this.pool) {
      const itemResult = await this.pool.query(
        `select sub_items from checklist_items where checklist_id = $1 and id = $2`,
        [checklistId, itemId],
      )
      if (!itemResult.rowCount) return null
      const subItems = normalizeSubItems(itemResult.rows[0].sub_items, { withDone: true })
      const parent = subItems.find((sub) => sub.id === subItemId)
      if (!parent) return null
      const parentSubSubItems = normalizeSubSubItems(parent.subItems, { withDone: true })
      if (!parentSubSubItems.some((subSub) => subSub.id === subSubItemId)) return null
      const nextSubItems = subItems.map((sub) => {
        if (sub.id !== subItemId) return sub
        const nextSubSubItems = parentSubSubItems.filter((subSub) => subSub.id !== subSubItemId)
        // With sub-sub-items the sub-item is the roll-up; with none left, keep
        // its current stored `done`.
        const nextDone =
          nextSubSubItems.length > 0
            ? nextSubSubItems.every((subSub) => subSub.done)
            : Boolean(sub.done)
        const nextSub = { ...sub, done: nextDone }
        if (nextSubSubItems.length > 0) {
          nextSub.subItems = nextSubSubItems
        } else {
          delete nextSub.subItems
        }
        return nextSub
      })
      await this.pool.query(
        `update checklist_items
         set sub_items = $3::jsonb, done = $4, ${completedAtClause(4)}, updated_at = now()
         where checklist_id = $1 and id = $2`,
        [checklistId, itemId, JSON.stringify(nextSubItems), nextSubItems.every((sub) => sub.done)],
      )
      const data = await this.read()
      return data.checklists.find((checklist) => checklist.id === checklistId) ?? null
    }

    const data = await readJson(localDataPath)
    let updatedChecklist = null
    let subSubItemFound = false
    data.checklists = data.checklists.map((checklist) => {
      if (checklist.id !== checklistId) return checklist
      const items = checklist.items.map((item) => {
        if (item.id !== itemId) return item
        const subItems = normalizeSubItems(item.subItems, { withDone: true })
        const parent = subItems.find((sub) => sub.id === subItemId)
        if (!parent) return item
        const parentSubSubItems = normalizeSubSubItems(parent.subItems, { withDone: true })
        if (!parentSubSubItems.some((subSub) => subSub.id === subSubItemId)) return item
        subSubItemFound = true
        const nextSubItems = subItems.map((sub) => {
          if (sub.id !== subItemId) return sub
          const nextSubSubItems = parentSubSubItems.filter((subSub) => subSub.id !== subSubItemId)
          const nextDone =
            nextSubSubItems.length > 0
              ? nextSubSubItems.every((subSub) => subSub.done)
              : Boolean(sub.done)
          const nextSub = { ...sub, done: nextDone }
          if (nextSubSubItems.length > 0) {
            nextSub.subItems = nextSubSubItems
          } else {
            delete nextSub.subItems
          }
          return nextSub
        })
        return withCompletionStamp(
          { ...item, subItems: nextSubItems },
          nextSubItems.every((sub) => sub.done),
        )
      })
      updatedChecklist = { ...checklist, items }
      return updatedChecklist
    })
    if (!subSubItemFound || !updatedChecklist) return null
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return updatedChecklist
  }

  // ---- Structured "waiting on a person" blockers (waitingOns) ----
  //
  // Additive to the legacy free-text `waitingOn` note + `waiting` flag. Each
  // entry is a permanent record: the stage methods below EDIT it in place and
  // there is no method that removes one. Top-level items persist the list in the
  // `waiting_ons` column; sub-items / sub-sub ride the parent item's `sub_items`
  // JSONB. The file backend keeps the array on each node object. All of them
  // reuse `this.read()` for the in-memory shape, then persist the one affected
  // node.

  /**
   * Locate a node (item / sub-item / sub-sub-item) inside a checklist by path.
   * Returns `{ item, sub?, node }` where `node` is the deepest target, or null
   * when any segment is missing. Pure — operates on the in-memory checklist.
   */
  _findChecklistNode(checklist, { itemId, subItemId, subSubItemId }) {
    const item = (checklist.items ?? []).find((i) => i.id === itemId)
    if (!item) return null
    if (!subItemId) return { item, node: item }
    const sub = (item.subItems ?? []).find((s) => s.id === subItemId)
    if (!sub) return null
    if (!subSubItemId) return { item, sub, node: sub }
    const subSub = (sub.subItems ?? []).find((s) => s.id === subSubItemId)
    if (!subSub) return null
    return { item, sub, node: subSub }
  }

  /** A short display label for a node (its title/label). */
  _nodeLabel(node) {
    return node?.label ?? node?.title ?? ''
  }

  /**
   * Persist a mutated top-level item's `waitingOns` (PG: the column; sub/sub-sub
   * ride the item's sub_items JSONB, so we rewrite that instead). `item` is the
   * in-memory item AFTER mutation; `location.itemId` identifies the row.
   */
  async _persistItemWaitingOns(checklistId, item, isSubNode) {
    if (isSubNode) {
      await this.pool.query(
        `update checklist_items set sub_items = $3::jsonb, updated_at = now()
         where checklist_id = $1 and id = $2`,
        [
          checklistId,
          item.id,
          JSON.stringify(normalizeSubItems(item.subItems, { withDone: true })),
        ],
      )
    } else {
      await this.pool.query(
        `update checklist_items set waiting_ons = $3::jsonb, updated_at = now()
         where checklist_id = $1 and id = $2`,
        [checklistId, item.id, JSON.stringify(normalizeWaitingOns(item.waitingOns))],
      )
    }
  }

  /**
   * Push a new structured blocker onto the node at `location`. Returns
   * `{ checklist, entry, node: { assigneeId, label } }` or null when the node
   * (or checklist) is missing.
   *
   * THE ONE WRITE. Everything a wait carries — who, the message, and the task
   * it waits for — arrives here together, because the editor holds all three as
   * an unsaved draft until Save (featreq-8b7d06d7). `waitingForChecklistId` is
   * therefore applied to the node in the SAME call rather than by a follow-up
   * PATCH: a wait that saved but whose task link didn't would be a wait nobody
   * could repair, now that the saved fields are locked.
   *
   * Pass it as `undefined` to leave the node's existing link alone; `null` or
   * `''` clears it.
   */
  async addWaitingOn(
    checklistId,
    location,
    { blockerId, requestedBy, note, blockerType, waitingForChecklistId },
  ) {
    const entry = {
      id: `wo-${randomUUID().slice(0, 8)}`,
      blockerId: String(blockerId),
      requestedBy: String(requestedBy),
      createdAt: nowIso(),
    }
    if (typeof note === 'string' && note.trim()) entry.note = note.trim()
    // Only 'client' is stored; an employee wait is the default and stays absent
    // so existing rows and new ones look identical.
    if (blockerType === 'client') entry.blockerType = 'client'

    // Applied to the node itself (not the entry) so the existing "the task you
    // were waiting on is done" notification keeps reading the one field it has
    // always read — see server.js's `waitingForChecklistId === updatedChecklist.id`.
    const applyTaskLink = (node) => {
      if (waitingForChecklistId === undefined) return
      if (waitingForChecklistId === null || waitingForChecklistId === '') {
        delete node.waitingForChecklistId
      } else {
        node.waitingForChecklistId = String(waitingForChecklistId)
      }
    }

    if (this.pool) {
      const data = await this.read()
      const checklist = data.checklists.find((c) => c.id === checklistId)
      if (!checklist) return null
      const found = this._findChecklistNode(checklist, location)
      if (!found) return null
      found.node.waitingOns = [...(found.node.waitingOns ?? []), entry]
      applyTaskLink(found.node)
      await this._persistItemWaitingOns(checklistId, found.item, Boolean(location.subItemId))
      // A sub-node's link rides the `sub_items` JSONB the line above just
      // rewrote; a top-level item keeps it in its own column.
      if (!location.subItemId && waitingForChecklistId !== undefined) {
        await this.pool.query(
          `update checklist_items set waiting_for_checklist_id = $3, updated_at = now()
           where checklist_id = $1 and id = $2`,
          [checklistId, found.item.id, found.node.waitingForChecklistId ?? null],
        )
      }
      const fresh = await this.read()
      return {
        checklist: fresh.checklists.find((c) => c.id === checklistId) ?? checklist,
        entry,
        node: { assigneeId: found.item.assigneeId ?? null, label: this._nodeLabel(found.node) },
      }
    }

    const data = await readJson(localDataPath)
    const checklist = (data.checklists ?? []).find((c) => c.id === checklistId)
    if (!checklist) return null
    const found = this._findChecklistNode(checklist, location)
    if (!found) return null
    found.node.waitingOns = [...(found.node.waitingOns ?? []), entry]
    applyTaskLink(found.node)
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return {
      checklist,
      entry,
      node: { assigneeId: found.item.assigneeId ?? null, label: this._nodeLabel(found.node) },
    }
  }

  /**
   * Find (without mutating) a waiting-on entry by id across every node of a
   * checklist — for the auth lookup on done/cancel. Returns
   * `{ entry, assigneeId, label } | null`.
   */
  async getWaitingOn(checklistId, waitingOnId) {
    const data = await this.read()
    const checklist = data.checklists.find((c) => c.id === checklistId)
    if (!checklist) return null
    for (const item of checklist.items ?? []) {
      const scan = (node, ownerItem) => {
        const hit = (node.waitingOns ?? []).find((w) => w.id === waitingOnId)
        if (hit) {
          return { entry: hit, assigneeId: ownerItem.assigneeId ?? null, label: this._nodeLabel(node) }
        }
        return null
      }
      const atItem = scan(item, item)
      if (atItem) return atItem
      for (const sub of item.subItems ?? []) {
        const atSub = scan(sub, item)
        if (atSub) return atSub
        for (const subSub of sub.subItems ?? []) {
          const atSubSub = scan(subSub, item)
          if (atSubSub) return atSubSub
        }
      }
    }
    return null
  }

  /**
   * Walk a checklist (item → sub-item → sub-sub-item) to the node holding
   * `waitingOnId` and replace that entry with whatever `mutate` returns. Yields
   * `{ checklist, entry, assigneeId, label } | null`, where `entry` is the value
   * AFTER the mutation.
   *
   * `mutate` MUST return the updated entry. It used to be allowed to return
   * `null` to delete the row, which is what Cancel did; a saved wait is a
   * permanent record now (see lib/waiting-on-state.js), so that branch is gone
   * and a falsy return is a bug rather than an instruction.
   *
   * Both backends need this identical walk and differ only in how they persist.
   * Cardinal rule 1 says a persisted change must touch both; the surest way to
   * honor that is to leave only one body to change.
   */
  async _mutateWaitingOn(checklistId, waitingOnId, mutate) {
    const applyTo = (node) => {
      const list = node.waitingOns ?? []
      const index = list.findIndex((w) => w.id === waitingOnId)
      if (index === -1) return null
      const previous = list[index]
      const next = mutate(previous)
      if (!next) {
        throw new Error(
          'a waiting-on mutation must return the updated entry — saved waits are never removed',
        )
      }
      node.waitingOns = [...list.slice(0, index), next, ...list.slice(index + 1)]
      return next
    }

    const locate = (checklist) => {
      for (const item of checklist.items ?? []) {
        const atItem = applyTo(item)
        if (atItem) {
          return { item, entry: atItem, isSubNode: false, label: this._nodeLabel(item) }
        }
        for (const sub of item.subItems ?? []) {
          const atSub = applyTo(sub)
          if (atSub) {
            return { item, entry: atSub, isSubNode: true, label: this._nodeLabel(sub) }
          }
          for (const subSub of sub.subItems ?? []) {
            const atSubSub = applyTo(subSub)
            if (atSubSub) {
              return { item, entry: atSubSub, isSubNode: true, label: this._nodeLabel(subSub) }
            }
          }
        }
      }
      return null
    }

    if (this.pool) {
      const data = await this.read()
      const checklist = data.checklists.find((c) => c.id === checklistId)
      if (!checklist) return null
      const hit = locate(checklist)
      if (!hit) return null
      await this._persistItemWaitingOns(checklistId, hit.item, hit.isSubNode)
      const fresh = await this.read()
      return {
        checklist: fresh.checklists.find((c) => c.id === checklistId) ?? checklist,
        entry: hit.entry,
        assigneeId: hit.item.assigneeId ?? null,
        label: hit.label,
      }
    }

    const data = await readJson(localDataPath)
    const checklist = (data.checklists ?? []).find((c) => c.id === checklistId)
    if (!checklist) return null
    const hit = locate(checklist)
    if (!hit) return null
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return {
      checklist,
      entry: hit.entry,
      assigneeId: hit.item.assigneeId ?? null,
      label: hit.label,
    }
  }

  /**
   * Stage 1 of the hand-off: the blocker reports their part finished. The
   * record is KEPT — that is what preserves the name of whoever did the check,
   * which the old destructive version threw away. `alsoVerify` is for client
   * waits: no second party exists, so they finish in a single click.
   */
  async markWaitingOnDone(checklistId, waitingOnId, { userId, alsoVerify = false }) {
    const at = nowIso()
    return this._mutateWaitingOn(checklistId, waitingOnId, (entry) => ({
      ...entry,
      resolvedAt: at,
      resolvedBy: String(userId),
      ...(alsoVerify ? { verifiedAt: at, verifiedBy: String(userId) } : {}),
    }))
  }

  /**
   * Stage 2: the requester confirms and retires the wait. Still not deleted —
   * it stays on the step, struck through, as the record.
   */
  async markWaitingOnVerified(checklistId, waitingOnId, { userId }) {
    return this._mutateWaitingOn(checklistId, waitingOnId, (entry) => ({
      ...entry,
      verifiedAt: nowIso(),
      verifiedBy: String(userId),
    }))
  }

  /**
   * SEND BACK — the requester rejects the reported work and hands it straight
   * back to the blocker. "a button to not approve and send back with another
   * note" (featreq-b05a2f3a, her fourth round).
   *
   * The resolution has to be cleared or the wait would still read as `resolved`
   * and stay out of the blocker's queue — so it is MOVED onto `sendBacks[]`
   * rather than dropped. Nothing about the original is touched: the first note,
   * `requestedBy` and `createdAt` all stay exactly where they were, and each
   * lap appends one more event. That is the whole audit trail of a hand-off
   * that went round twice.
   *
   * No new SQL: both backends persist through `_mutateWaitingOn`, which writes
   * the node's whole `waitingOns` array back (Postgres: the existing
   * `checklist_items.waiting_ons` / `sub_items` JSONB update). What IS new is a
   * key inside that JSONB — see `normalizeWaitingOns`.
   */
  async markWaitingOnSentBack(checklistId, waitingOnId, { userId, note }) {
    const at = nowIso()
    return this._mutateWaitingOn(checklistId, waitingOnId, (entry) => {
      const { resolvedAt, resolvedBy, ...rest } = entry
      const event = { at, by: String(userId) }
      if (typeof note === 'string' && note.trim()) event.note = note.trim()
      if (resolvedAt) event.resolvedAt = resolvedAt
      if (resolvedBy) event.resolvedBy = resolvedBy
      return { ...rest, sendBacks: [...(entry.sendBacks ?? []), event] }
    })
  }

  /**
   * QUESTION — the person being waited on says something back without finishing.
   * Her annotated Delayed screenshot puts it beside Done: "a question / send
   * back button that opens a message box… sending does not complete the wait."
   *
   * So this touches NO stage field. `resolvedAt` is not set, nothing is
   * cleared, and the wait stays exactly where it was — on the blocker's Delayed
   * page, still their move. All that changes is one appended message (and the
   * notification the route sends afterwards).
   *
   * Append-only, like `sendBacks`: the two lists are the two directions of the
   * same conversation, and neither ever rewrites what is already in it.
   */
  async addWaitingOnQuestion(checklistId, waitingOnId, { userId, note }) {
    const at = nowIso()
    return this._mutateWaitingOn(checklistId, waitingOnId, (entry) => {
      const event = { at, by: String(userId) }
      if (typeof note === 'string' && note.trim()) event.note = note.trim()
      return { ...entry, questions: [...(entry.questions ?? []), event] }
    })
  }

  /**
   * Every pending waiting-on entry across all non-deleted checklists whose
   * `blockerId === userId`, flattened with the step context a blocker needs to
   * see what they're holding up. Requester + client names are resolved for
   * display.
   */
  async listWaitingOnMe(userId) {
    const data = await this.read()
    const members = await this.getTeamMembers()
    const nameById = new Map(members.map((m) => [m.id, m.name]))
    const clientNameById = new Map((data.clients ?? []).map((c) => [c.id, c.name]))
    const rows = []

    for (const checklist of data.checklists ?? []) {
      if (checklist.deletedAt) continue
      const push = (node, itemLabel, subLabel) => {
        for (const w of node.waitingOns ?? []) {
          if (w.blockerId !== userId) continue
          // Entries now outlive their resolution (they carry the name of who
          // did the check), so "pending" has to be asked for explicitly —
          // otherwise you'd keep being told about work you already finished.
          if (waitingOnStage(w) !== 'waiting') continue
          rows.push({
            checklistId: checklist.id,
            checklistTitle: checklist.title,
            clientId: checklist.clientId,
            clientName: clientNameById.get(checklist.clientId) ?? 'Unknown client',
            itemLabel,
            subLabel: subLabel ?? undefined,
            waitingOnId: w.id,
            note: w.note ?? undefined,
            requestedById: w.requestedBy,
            requestedByName: nameById.get(w.requestedBy) ?? 'A team member',
            createdAt: w.createdAt,
          })
        }
      }
      for (const item of checklist.items ?? []) {
        push(item, item.label, undefined)
        for (const sub of item.subItems ?? []) {
          push(sub, item.label, sub.title)
          for (const subSub of sub.subItems ?? []) {
            push(subSub, item.label, `${sub.title} › ${subSub.title}`)
          }
        }
      }
    }

    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    return rows
  }

  async getLoginOptions() {
    if (this.pool) {
      const result = await this.pool.query(`
        select id, name, email, role, staff_role
        from users
        order by case when role = 'owner' then 0 else 1 end, name asc
      `)

      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role === 'owner' ? 'owner' : 'employee',
        staffRole: row.staff_role,
      }))
    }

    const authState = await readJson(localAuthPath)
    return authState.users.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role === 'owner' ? 'owner' : 'employee',
      staffRole: user.staffRole,
    }))
  }

  async createSession(userId, password) {
    if (this.pool) {
      const result = await this.pool.query(
        `
          select id, name, email, role, staff_role, password_hash
          from users
          where id = $1
        `,
        [userId],
      )

      if (!result.rowCount) {
        return null
      }

      const user = result.rows[0]
      if (!verifyPassword(password, user.password_hash)) {
        return null
      }

      const sessionId = randomUUID()
      const expiresAt = new Date(Date.now() + sessionTtlMs)
      await this.pool.query(
        `
          insert into sessions (id, user_id, expires_at)
          values ($1, $2, $3)
        `,
        [sessionId, user.id, expiresAt.toISOString()],
      )

      return {
        sessionId,
        user: mapSessionUser({
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          staffRole: user.staff_role,
        }),
        expiresAt,
      }
    }

    const authState = await readJson(localAuthPath)
    const user = authState.users.find((item) => item.id === userId)
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return null
    }

    const sessionId = randomUUID()
    const expiresAt = new Date(Date.now() + sessionTtlMs).toISOString()
    authState.sessions = authState.sessions.filter((session) => new Date(session.expiresAt).getTime() > Date.now())
    authState.sessions.push({ id: sessionId, userId: user.id, expiresAt })
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))

    return {
      sessionId,
      user: mapSessionUser(user),
      expiresAt: new Date(expiresAt),
    }
  }

  async getSession(sessionId) {
    if (!sessionId) {
      return null
    }

    if (this.pool) {
      const result = await this.pool.query(
        `
          select s.id, s.expires_at, u.id as user_id, u.name, u.email, u.role, u.staff_role
          from sessions s
          join users u on u.id = s.user_id
          where s.id = $1 and s.expires_at > now()
        `,
        [sessionId],
      )

      if (!result.rowCount) {
        await this.deleteSession(sessionId)
        return null
      }

      const session = result.rows[0]
      return {
        sessionId: session.id,
        expiresAt: new Date(session.expires_at),
        user: mapSessionUser({
          id: session.user_id,
          name: session.name,
          email: session.email,
          role: session.role,
          staffRole: session.staff_role,
        }),
      }
    }

    const authState = await readJson(localAuthPath)
    const now = Date.now()
    authState.sessions = authState.sessions.filter((session) => new Date(session.expiresAt).getTime() > now)
    const session = authState.sessions.find((item) => item.id === sessionId)
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))

    if (!session) {
      return null
    }

    const user = authState.users.find((item) => item.id === session.userId)
    if (!user) {
      return null
    }

    return {
      sessionId: session.id,
      expiresAt: new Date(session.expiresAt),
      user: mapSessionUser(user),
    }
  }

  async deleteSession(sessionId) {
    if (!sessionId) {
      return
    }

    if (this.pool) {
      await this.pool.query('delete from sessions where id = $1', [sessionId])
      return
    }

    const authState = await readJson(localAuthPath)
    authState.sessions = authState.sessions.filter((session) => session.id !== sessionId)
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
  }

  async getTeamMembers() {
    if (this.pool) {
      // Active members only — soft-deleted users still exist in the table
      // (for historical analytics) but should never show up on the Team
      // admin page. Owner re-adds with a fresh invite to undo a removal.
      const result = await this.pool.query(`
        select id, name, email, role, staff_role, magic_token, token_revoked_at, last_active_at, created_at,
               totp_enabled, cost_rate, bill_rate, email_notification_prefs
        from users
        where inactive_at is null
        order by sort_order asc nulls last, name asc
      `)

      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role === 'owner' ? 'owner' : 'employee',
        staffRole: row.staff_role,
        magicToken: row.magic_token ?? null,
        tokenRevokedAt: row.token_revoked_at ? new Date(row.token_revoked_at).toISOString() : null,
        lastActiveAt: row.last_active_at ? new Date(row.last_active_at).toISOString() : null,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        totpEnabled: Boolean(row.totp_enabled),
        costRate: row.cost_rate == null ? null : Number(row.cost_rate),
        billRate: row.bill_rate == null ? null : Number(row.bill_rate),
        emailNotificationPrefs:
          row.email_notification_prefs && typeof row.email_notification_prefs === 'object'
            ? row.email_notification_prefs
            : {},
      }))
    }

    const authState = await readJson(localAuthPath)
    return (authState.users ?? []).filter((user) => !user.inactiveAt).map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role === 'owner' ? 'owner' : 'employee',
      staffRole: user.staffRole,
      magicToken: user.magicToken ?? null,
      tokenRevokedAt: user.tokenRevokedAt ?? null,
      lastActiveAt: user.lastActiveAt ?? null,
      createdAt: user.createdAt ?? null,
      totpEnabled: Boolean(user.totpEnabled),
      costRate: typeof user.costRate === 'number' ? user.costRate : null,
      billRate: typeof user.billRate === 'number' ? user.billRate : null,
      emailNotificationPrefs:
        user.emailNotificationPrefs && typeof user.emailNotificationPrefs === 'object'
          ? user.emailNotificationPrefs
          : {},
    }))
  }

  /**
   * Owner-only: set or clear a team member's cost/pay rate (assistant Phase 4).
   * `rate` is a non-negative number, or null to clear. Informational only —
   * never affects invoices. Returns the normalized rate (or null).
   */
  async setEmployeeCostRate(userId, rate) {
    if (!userId) return null
    let normalized = null
    if (rate !== null && rate !== undefined && rate !== '') {
      const n = Number(rate)
      if (!Number.isFinite(n) || n < 0) return null
      normalized = Math.round(n * 100) / 100
    }

    if (this.pool) {
      await this.pool.query(`update users set cost_rate = $2 where id = $1`, [userId, normalized])
      return normalized
    }

    const authState = await readJson(localAuthPath)
    const user = (authState.users ?? []).find((u) => u.id === userId)
    if (!user) return null
    if (normalized === null) delete user.costRate
    else user.costRate = normalized
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return normalized
  }

  /**
   * Owner-only: set or clear a team member's BILL rate ($/hour charged to
   * clients for this person's time). `rate` is a non-negative number, or null
   * to clear. Unlike cost_rate this DOES feed invoices (hourly clients are
   * billed off each employee's bill rate). Returns the normalized rate (or null).
   */
  async setEmployeeBillRate(userId, rate) {
    if (!userId) return null
    let normalized = null
    if (rate !== null && rate !== undefined && rate !== '') {
      const n = Number(rate)
      if (!Number.isFinite(n) || n < 0) return null
      normalized = Math.round(n * 100) / 100
    }

    if (this.pool) {
      await this.pool.query(`update users set bill_rate = $2 where id = $1`, [userId, normalized])
      return normalized
    }

    const authState = await readJson(localAuthPath)
    const user = (authState.users ?? []).find((u) => u.id === userId)
    if (!user) return null
    if (normalized === null) delete user.billRate
    else user.billRate = normalized
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return normalized
  }

  async getTeamMember(userId) {
    const members = await this.getTeamMembers()
    return members.find((member) => member.id === userId) ?? null
  }

  /**
   * Replace a user's email notification preferences with an already-sanitized
   * sparse map of { prefKey: boolean } (see lib/notification-prefs.js — the
   * endpoint sanitizes before calling). Returns the stored prefs, or null when
   * the user doesn't exist.
   */
  async setEmailNotificationPrefs(userId, prefs) {
    if (!userId) return null
    const clean = prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : {}

    if (this.pool) {
      const result = await this.pool.query(
        `update users set email_notification_prefs = $2::jsonb, updated_at = now() where id = $1 returning id`,
        [userId, JSON.stringify(clean)],
      )
      return result.rowCount ? clean : null
    }

    const authState = await readJson(localAuthPath)
    const user = (authState.users ?? []).find((u) => u.id === userId)
    if (!user) return null
    user.emailNotificationPrefs = clean
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return clean
  }

  /**
   * Append steps to ONE stage of a recurring template — the "add to the series"
   * half of adding a task to a live recurring checklist. Targeted append only
   * (never edits or removes existing template steps), so it can safely be
   * exposed to a non-owner assigned to the template's client. Returns the
   * created items (`{ id, label }`) in order, or null when the template/stage
   * doesn't exist.
   */
  async appendChecklistTemplateStageItems(templateId, stageId, labels) {
    const clean = (Array.isArray(labels) ? labels : [])
      .filter((label) => typeof label === 'string' && label.trim())
      .map((label) => label.trim())
    if (clean.length === 0) return []

    if (this.pool) {
      const stage = await this.pool.query(
        'select id from checklist_template_stages where id = $1 and template_id = $2',
        [stageId, templateId],
      )
      if (!stage.rowCount) return null
      const maxRow = await this.pool.query(
        'select coalesce(max(sort_order), -1) as max from checklist_template_items where stage_id = $1',
        [stageId],
      )
      let nextOrder = Number(maxRow.rows[0]?.max ?? -1) + 1
      const created = []
      for (const label of clean) {
        const id = `template-item-${randomUUID().slice(0, 8)}`
        await this.pool.query(
          `insert into checklist_template_items
             (id, template_id, label, sort_order, due_date, due_day_of_month, assignee_id, stage_id, sub_items, updated_at)
           values ($1, $2, $3, $4, null, null, null, $5, '[]'::jsonb, now())`,
          [id, templateId, label, nextOrder, stageId],
        )
        created.push({ id, label })
        nextOrder += 1
      }
      return created
    }

    const data = await readJson(localDataPath)
    const template = (data.checklistTemplates ?? []).find((item) => item.id === templateId)
    if (!template) return null
    const stage = (template.stages ?? []).find((item) => item.id === stageId)
    if (!stage) return null
    const created = clean.map((label) => ({ id: `template-item-${randomUUID().slice(0, 8)}`, label }))
    stage.items = [...(stage.items ?? []), ...created]
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return created
  }

  /**
   * A client's display name by id, or null. Small targeted lookup used by the
   * notification layer to label emails with the client they're about — cheap in
   * Postgres (single row), a file read otherwise.
   */
  async getClientNameById(clientId) {
    if (!clientId) return null
    if (this.pool) {
      const result = await this.pool.query('select name from clients where id = $1', [clientId])
      return result.rows[0]?.name ?? null
    }
    const data = await this.read()
    return (data.clients ?? []).find((client) => client.id === clientId)?.name ?? null
  }

  /**
   * The client name for the client a checklist belongs to, or null. Lets a
   * notification that only knows its `checklistId` still name the client.
   */
  async getClientNameForChecklist(checklistId) {
    if (!checklistId) return null
    if (this.pool) {
      const result = await this.pool.query(
        `select c.name from clients c
           join checklists k on k.client_id = c.id
          where k.id = $1`,
        [checklistId],
      )
      return result.rows[0]?.name ?? null
    }
    const data = await this.read()
    const checklist = (data.checklists ?? []).find((item) => item.id === checklistId)
    if (!checklist) return null
    return (data.clients ?? []).find((client) => client.id === checklist.clientId)?.name ?? null
  }

  /**
   * Persist a new top-to-bottom order for the team roster. `orderedIds` is the
   * full list of member ids in the desired order; each gets sort_order 0..n-1.
   * Returns the freshly-ordered team list, or null if nothing matched.
   */
  async reorderTeamMembers(orderedIds) {
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return null
    }
    if (this.pool) {
      const cases = orderedIds.map((id, idx) => `when id = $${idx + 1} then ${idx}`).join(' ')
      const result = await this.pool.query(
        `
          update users
          set sort_order = case ${cases} end
          where id = any($${orderedIds.length + 1}::text[]) and inactive_at is null
        `,
        [...orderedIds, orderedIds],
      )
      if (!result.rowCount) {
        return null
      }
      return this.getTeamMembers()
    }

    const authState = await readJson(localAuthPath)
    const users = authState.users ?? []
    const byId = new Map(users.map((user) => [user.id, user]))
    const reordered = orderedIds.map((id) => byId.get(id)).filter(Boolean)
    if (reordered.length === 0) {
      return null
    }
    const seen = new Set(orderedIds)
    const tail = users.filter((user) => !seen.has(user.id))
    authState.users = [...reordered, ...tail]
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return this.getTeamMembers()
  }

  async createTeamMember({ name, email, staffRole }) {
    const trimmedName = String(name ?? '').trim()
    const trimmedEmail = String(email ?? '').trim().toLowerCase()
    const normalizedStaffRole = staffRole === 'Senior Bookkeeper' ? 'Accountant' : staffRole
    const safeStaffRole = ['Owner', 'Accountant', 'Bookkeeper'].includes(normalizedStaffRole)
      ? normalizedStaffRole
      : 'Bookkeeper'

    if (!trimmedName || !trimmedEmail) {
      throw new Error('Name and email are required')
    }

    const id = `emp-${randomUUID().slice(0, 8)}`
    const role = roleToDbRole(safeStaffRole)
    const magicToken = generateMagicToken()
    // SECURITY (M2): never seed new members with the shared demo password.
    // They onboard via a one-time magic link and set their own password from
    // the Security page, so they never need to know this value — it just must
    // not be a known/guessable credential. Hash a fresh high-entropy random
    // secret instead (covers BOTH the Postgres and file-fallback branches
    // below, since both read this same `passwordHash`).
    const passwordHash = hashPassword(randomBytes(32).toString('base64url'))
    const createdAt = nowIso()

    if (this.pool) {
      await this.pool.query(
        `
          insert into users (id, name, email, role, staff_role, password_hash, magic_token)
          values ($1, $2, $3, $4, $5, $6, $7)
        `,
        [id, trimmedName, trimmedEmail, role, safeStaffRole, passwordHash, magicToken],
      )
      return this.getTeamMember(id)
    }

    const authState = await readJson(localAuthPath)
    if ((authState.users ?? []).some((user) => user.email && user.email.toLowerCase() === trimmedEmail)) {
      throw new Error('A team member with that email already exists')
    }

    authState.users = [
      ...(authState.users ?? []),
      {
        id,
        name: trimmedName,
        email: trimmedEmail,
        role,
        staffRole: safeStaffRole,
        passwordHash,
        magicToken,
        tokenRevokedAt: null,
        lastActiveAt: null,
        createdAt,
      },
    ]
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return this.getTeamMember(id)
  }

  async regenerateMagicToken(userId) {
    const token = generateMagicToken()

    if (this.pool) {
      const result = await this.pool.query(
        `
          update users
          set magic_token = $2,
              token_revoked_at = null,
              updated_at = now()
          where id = $1
          returning id
        `,
        [userId, token],
      )
      if (!result.rowCount) {
        return null
      }
      return this.getTeamMember(userId)
    }

    const authState = await readJson(localAuthPath)
    let found = false
    authState.users = (authState.users ?? []).map((user) => {
      if (user.id !== userId) {
        return user
      }
      found = true
      return { ...user, magicToken: token, tokenRevokedAt: null }
    })
    if (!found) {
      return null
    }
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return this.getTeamMember(userId)
  }

  async revokeMagicToken(userId) {
    const revokedAt = nowIso()

    if (this.pool) {
      const result = await this.pool.query(
        `
          update users
          set token_revoked_at = $2,
              updated_at = now()
          where id = $1
          returning id
        `,
        [userId, revokedAt],
      )
      if (!result.rowCount) {
        return null
      }
      // Also clear active sessions for this user.
      await this.pool.query('delete from sessions where user_id = $1', [userId])
      return this.getTeamMember(userId)
    }

    const authState = await readJson(localAuthPath)
    let found = false
    authState.users = (authState.users ?? []).map((user) => {
      if (user.id !== userId) {
        return user
      }
      found = true
      return { ...user, tokenRevokedAt: revokedAt }
    })
    if (!found) {
      return null
    }
    authState.sessions = (authState.sessions ?? []).filter((session) => session.userId !== userId)
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return this.getTeamMember(userId)
  }

  async restoreMagicToken(userId) {
    // Restore is implemented as regenerate: clears revoked flag AND issues a fresh token.
    return this.regenerateMagicToken(userId)
  }

  /**
   * SOFT-delete a team member. The user row stays in the DB with an
   * `inactive_at` timestamp set; their time entries (and any other
   * historical attribution) remain pointed at them so the analytics
   * pages' "include former team members" toggle has real data to show.
   *
   * What still happens:
   *  - Active in-flight checklists / templates / template stages get
   *    reassigned to the calling owner so work doesn't stall.
   *  - Nullable per-item assignee fields are cleared.
   *  - Viewer / editor / assigned_bookkeeper arrays drop the user id
   *    (no lingering visibility).
   *  - All of their sessions are revoked (logged out of every device).
   *  - Their pending login tokens are revoked.
   *  - Magic token nulled so any old emailed link goes dead.
   *
   * What changed from the prior hard-delete behaviour:
   *  - Time entries STAY attributed to them (was: reassigned to owner).
   *  - `time_entries.approved_by` STAYS pointed at them when they approved.
   *  - Timesheet locks STAY (they're historical sign-offs).
   *  - The user row itself stays.
   *
   * `ownerId` is the calling owner — still used as the new assignee for
   * the FK-restricted active-work tables. Wrapped in a transaction so a
   * partial failure doesn't leave a half-removed user.
   *
   * Returns { ok: true } on success or { ok: false, reason: 'not_found' }
   * when the user doesn't exist (or is already inactive).
   */
  async deleteTeamMember(userId, ownerId) {
    const inactiveAt = nowIso()

    if (this.pool) {
      const client = await this.pool.connect()
      try {
        await client.query('begin')

        // Reassign every NOT NULL assignee_id FK to the owner so the
        // remaining active work has an actual assignee. The user row
        // STAYS so historical attribution survives.
        await client.query(
          `update checklists set assignee_id = $1 where assignee_id = $2 and deleted_at is null`,
          [ownerId, userId],
        )
        await client.query(
          `update checklist_templates set assignee_id = $1 where assignee_id = $2`,
          [ownerId, userId],
        )
        await client.query(
          `update checklist_template_stages set assignee_id = $1 where assignee_id = $2`,
          [ownerId, userId],
        )

        // Per-item assignee columns are nullable text — clear so the
        // owner sees an unassigned step rather than a ghost name.
        await client.query(
          `update checklist_items set assignee_id = null where assignee_id = $1`,
          [userId],
        )
        await client.query(
          `update checklist_template_items set assignee_id = null where assignee_id = $1`,
          [userId],
        )

        // Strip from every visibility array — they shouldn't see new
        // anything. (Historical attribution doesn't depend on these.)
        await client.query(
          `update checklists
             set viewer_ids = array_remove(viewer_ids, $1),
                 editor_ids = array_remove(editor_ids, $1)
             where $1 = any(viewer_ids) or $1 = any(editor_ids)`,
          [userId],
        )
        await client.query(
          `update checklist_templates
             set viewer_ids = array_remove(viewer_ids, $1),
                 editor_ids = array_remove(editor_ids, $1)
             where $1 = any(viewer_ids) or $1 = any(editor_ids)`,
          [userId],
        )
        await client.query(
          `update checklist_template_stages
             set viewer_ids = array_remove(viewer_ids, $1),
                 editor_ids = array_remove(editor_ids, $1)
             where $1 = any(viewer_ids) or $1 = any(editor_ids)`,
          [userId],
        )
        await client.query(
          `update clients
             set assigned_bookkeeper_ids = array_remove(assigned_bookkeeper_ids, $1)
             where $1 = any(assigned_bookkeeper_ids)`,
          [userId],
        )

        // Revoke sessions + magic tokens so the user can't continue
        // using an open tab and any stale email link won't work.
        await client.query(`delete from sessions where user_id = $1`, [userId])
        // The active session system is `user_sessions` (the legacy `sessions`
        // table above is no longer what auth reads) — revoke those too so an
        // already-open tab stops working immediately.
        await client.query(`delete from user_sessions where user_id = $1`, [userId])
        await client.query(`delete from login_tokens where user_id = $1`, [userId])
        await client.query(
          `update users
             set magic_token = null,
                 token_revoked_at = now(),
                 inactive_at = $2,
                 updated_at = now()
             where id = $1 and inactive_at is null`,
          [userId, inactiveAt],
        )

        // Check the update touched a row (i.e. the user existed AND was
        // active). If not, this was a no-op — return not_found so the
        // caller can show a proper error.
        const verify = await client.query(
          `select 1 from users where id = $1 and inactive_at is not null`,
          [userId],
        )
        if (!verify.rowCount) {
          await client.query('rollback')
          return { ok: false, reason: 'not_found' }
        }
        await client.query('commit')
        return { ok: true }
      } catch (error) {
        await client.query('rollback')
        throw error
      } finally {
        client.release()
      }
    }

    // File mode: mirror the cleanup on the in-memory JSON shape.
    const data = await readJson(localDataPath)

    const stripArrayId = (arr) =>
      Array.isArray(arr) ? arr.filter((id) => id !== userId) : arr ?? []

    const reassignChecklist = (checklist) => ({
      ...checklist,
      // Only reassign active (non-recycled) checklists; recycled ones
      // are historical and should stay attributed.
      assigneeId:
        checklist.assigneeId === userId && !checklist.deletedAt
          ? ownerId
          : checklist.assigneeId,
      viewerIds: stripArrayId(checklist.viewerIds),
      editorIds: stripArrayId(checklist.editorIds),
      items: Array.isArray(checklist.items)
        ? checklist.items.map((item) =>
            item && item.assigneeId === userId ? { ...item, assigneeId: null } : item,
          )
        : checklist.items,
    })

    data.checklists = (data.checklists ?? []).map(reassignChecklist)
    data.recycledChecklists = (data.recycledChecklists ?? []).map(reassignChecklist)

    data.checklistTemplates = (data.checklistTemplates ?? []).map((template) => ({
      ...template,
      assigneeId: template.assigneeId === userId ? ownerId : template.assigneeId,
      viewerIds: stripArrayId(template.viewerIds),
      editorIds: stripArrayId(template.editorIds),
      items: Array.isArray(template.items)
        ? template.items.map((item) =>
            item && item.assigneeId === userId ? { ...item, assigneeId: null } : item,
          )
        : template.items,
      stages: Array.isArray(template.stages)
        ? template.stages.map((stage) => ({
            ...stage,
            assigneeId: stage.assigneeId === userId ? ownerId : stage.assigneeId,
            viewerIds: stripArrayId(stage.viewerIds),
            editorIds: stripArrayId(stage.editorIds),
          }))
        : template.stages,
    }))

    data.clients = (data.clients ?? []).map((client) => ({
      ...client,
      assignedBookkeeperIds: stripArrayId(client.assignedBookkeeperIds),
      assignedEmployeeIds: stripArrayId(client.assignedEmployeeIds),
    }))

    // NOTE: time entries + timesheet locks are NOT touched. They stay
    // attributed to the (now inactive) user so analytics preserve history.

    await writeFile(localDataPath, JSON.stringify(data, null, 2))

    const authState = await readJson(localAuthPath)
    const target = (authState.users ?? []).find((user) => user.id === userId)
    if (!target || target.inactiveAt) {
      return { ok: false, reason: 'not_found' }
    }
    target.inactiveAt = inactiveAt
    target.magicToken = null
    target.tokenRevokedAt = inactiveAt
    authState.sessions = (authState.sessions ?? []).filter((session) => session.userId !== userId)
    authState.userSessions = (authState.userSessions ?? []).filter(
      (session) => session.userId !== userId,
    )
    authState.loginTokens = (authState.loginTokens ?? []).filter(
      (token) => token.userId !== userId,
    )
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return { ok: true }
  }

  async findUserByMagicToken(token) {
    if (!token) {
      return null
    }

    if (this.pool) {
      const result = await this.pool.query(
        `
          select id, name, email, role, staff_role, magic_token, token_revoked_at
          from users
          where magic_token = $1
        `,
        [token],
      )
      if (!result.rowCount) {
        return null
      }
      const row = result.rows[0]
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
        staffRole: row.staff_role,
        magicToken: row.magic_token,
        tokenRevokedAt: row.token_revoked_at ? new Date(row.token_revoked_at).toISOString() : null,
      }
    }

    const authState = await readJson(localAuthPath)
    const user = (authState.users ?? []).find((entry) => entry.magicToken === token)
    if (!user) {
      return null
    }
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      staffRole: user.staffRole,
      magicToken: user.magicToken,
      tokenRevokedAt: user.tokenRevokedAt ?? null,
    }
  }

  async createSessionForUser(userId) {
    const sessionId = randomUUID()
    const expiresAt = new Date(Date.now() + sessionTtlMs)

    if (this.pool) {
      await this.pool.query(
        `insert into sessions (id, user_id, expires_at) values ($1, $2, $3)`,
        [sessionId, userId, expiresAt.toISOString()],
      )
      await this.pool.query(
        `update users set last_active_at = now() where id = $1`,
        [userId],
      )
      const result = await this.pool.query(
        `select id, name, email, role, staff_role from users where id = $1`,
        [userId],
      )
      if (!result.rowCount) {
        return null
      }
      const row = result.rows[0]
      return {
        sessionId,
        expiresAt,
        user: mapSessionUser({
          id: row.id,
          name: row.name,
          email: row.email,
          role: row.role,
          staffRole: row.staff_role,
        }),
      }
    }

    const authState = await readJson(localAuthPath)
    const user = (authState.users ?? []).find((entry) => entry.id === userId)
    if (!user) {
      return null
    }
    user.lastActiveAt = nowIso()
    authState.sessions = [
      ...((authState.sessions ?? []).filter(
        (session) => new Date(session.expiresAt).getTime() > Date.now(),
      )),
      { id: sessionId, userId: user.id, expiresAt: expiresAt.toISOString() },
    ]
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return {
      sessionId,
      expiresAt,
      user: mapSessionUser(user),
    }
  }

  async touchUserActivity(userId) {
    if (!userId) {
      return
    }

    if (this.pool) {
      await this.pool.query(`update users set last_active_at = now() where id = $1`, [userId])
      return
    }

    const authState = await readJson(localAuthPath)
    let mutated = false
    authState.users = (authState.users ?? []).map((user) => {
      if (user.id !== userId) {
        return user
      }
      mutated = true
      return { ...user, lastActiveAt: nowIso() }
    })
    if (mutated) {
      await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    }
  }

  // ---- Feature requests / "Updates" tracker (owner-only) ----
  //
  // The same `feature_requests` table backs both the assistant's "send to Alex"
  // flow (which creates a row with status 'sent', read as 'new') and the
  // owner-only Updates tracker (drag-rank + urgent + status + dev notes).
  // Endpoint-managed (NOT part of the bulk /api/app-data write).

  /**
   * Shape a stored feature-request row/record into the camelCase object the
   * client expects. Maps the legacy status 'sent' → 'new'.
   */
  static mapFeatureRequest(row) {
    const rawStatus = String(row.status ?? 'new')
    const status = rawStatus === 'sent' ? 'new' : rawStatus
    // Priority: prefer the stored level; validate to one of the 4; otherwise
    // derive from the legacy `urgent` flag, defaulting to 'medium'.
    const rawPriority = row.priority ?? row.priorityLevel
    const priority = FEATURE_REQUEST_PRIORITIES.includes(rawPriority)
      ? rawPriority
      : row.urgent
        ? 'urgent'
        : 'medium'
    return {
      id: row.id,
      userId: row.user_id ?? row.userId,
      title: row.title ?? '',
      description: row.description ?? '',
      type: row.type ?? 'feature',
      status,
      priority,
      priorityRank: Number(row.priority_rank ?? row.priorityRank ?? 0) || 0,
      devNotes: row.dev_notes ?? row.devNotes ?? null,
      approvedBy: row.approved_by ?? row.approvedBy ?? null,
      approvedAt: row.approved_at
        ? new Date(row.approved_at).toISOString()
        : (row.approvedAt ?? null),
      reviewNote: row.review_note ?? row.reviewNote ?? null,
      reviewedBy: row.reviewed_by ?? row.reviewedBy ?? null,
      reviewedAt: row.reviewed_at
        ? new Date(row.reviewed_at).toISOString()
        : (row.reviewedAt ?? null),
      clarificationQuestion:
        row.clarification_question ?? row.clarificationQuestion ?? null,
      clarificationAnswer: row.clarification_answer ?? row.clarificationAnswer ?? null,
      shippedAt: row.shipped_at
        ? new Date(row.shipped_at).toISOString()
        : (row.shippedAt ?? null),
      createdAt: row.created_at
        ? new Date(row.created_at).toISOString()
        : (row.createdAt ?? nowIso()),
      updatedAt: row.updated_at
        ? new Date(row.updated_at).toISOString()
        : (row.updatedAt ?? null),
    }
  }

  /**
   * Every feature request, ordered urgent-first, then priority_rank asc, then
   * created_at asc. Owner-only at the endpoint layer.
   */
  async listFeatureRequests() {
    if (this.pool) {
      const result = await this.pool.query(
        `select id, user_id, title, description, type, status, urgent, priority,
                priority_rank, dev_notes, approved_by, approved_at,
                review_note, reviewed_by, reviewed_at,
                clarification_question, clarification_answer, shipped_at,
                created_at, updated_at
           from feature_requests
          order by ${FEATURE_REQUEST_PRIORITY_WEIGHT_SQL} asc,
                   priority_rank asc, created_at asc`,
      )
      return result.rows.map((row) => AppDataStore.mapFeatureRequest(row))
    }
    const authState = await readJson(localAuthPath)
    const list = Array.isArray(authState.featureRequests) ? authState.featureRequests : []
    const weight = (p) => FEATURE_REQUEST_PRIORITY_WEIGHT[p] ?? FEATURE_REQUEST_PRIORITY_WEIGHT.medium
    return list
      .map((r) => AppDataStore.mapFeatureRequest(r))
      .sort(
        (a, b) =>
          weight(a.priority) - weight(b.priority) ||
          a.priorityRank - b.priorityRank ||
          a.createdAt.localeCompare(b.createdAt),
      )
  }

  /**
   * Record a feature request. Used by both the assistant "send to Alex" flow
   * (3-arg call, defaults type 'feature' / status 'sent') and the Updates
   * tracker's add form (opts.type). New items land at the bottom of the rank
   * order (priority_rank = current max + 1). Returns the created record.
   */
  async createFeatureRequest(userId, title, description, opts = {}) {
    const id = `featreq-${randomUUID().slice(0, 8)}`
    const createdAt = nowIso()
    const allowedTypes = ['feature', 'bug', 'improvement']
    const type = allowedTypes.includes(opts.type) ? opts.type : 'feature'
    // Priority can be chosen at creation (Updates add form); anything absent
    // or invalid lands on 'medium', matching the old always-medium behavior.
    const priority = FEATURE_REQUEST_PRIORITIES.includes(opts.priority)
      ? opts.priority
      : 'medium'
    // A "Just spitballing" save lands in Britt's Brain (status 'brainstorm')
    // instead of the intake pile — it's an idea to revisit, not filed work.
    // Only this one status can be chosen at creation; everything else still
    // starts at 'sent' and moves via the normal update path.
    const status = opts.brainstorm === true ? 'brainstorm' : 'sent'
    const record = {
      id,
      userId,
      title: String(title ?? '').slice(0, 120),
      description: String(description ?? '').slice(0, 2000),
      type,
      status,
      priority,
      priorityRank: 0,
      devNotes: null,
      reviewNote: null,
      reviewedBy: null,
      reviewedAt: null,
      createdAt,
      updatedAt: null,
    }

    if (this.pool) {
      const maxRow = await this.pool.query(
        `select coalesce(max(priority_rank), -1) + 1 as next from feature_requests`,
      )
      record.priorityRank = Number(maxRow.rows[0]?.next ?? 0) || 0
      await this.pool.query(
        `insert into feature_requests
           (id, user_id, title, description, type, status, priority, priority_rank, dev_notes, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          record.id,
          record.userId,
          record.title,
          record.description,
          record.type,
          record.status,
          record.priority,
          record.priorityRank,
          record.devNotes,
          createdAt,
        ],
      )
      return AppDataStore.mapFeatureRequest({ ...record, status: 'new' })
    }

    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.featureRequests)) authState.featureRequests = []
    const maxRank = authState.featureRequests.reduce(
      (max, r) => Math.max(max, Number(r.priorityRank ?? r.priority_rank ?? 0) || 0),
      -1,
    )
    record.priorityRank = maxRank + 1
    authState.featureRequests.push(record)
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return AppDataStore.mapFeatureRequest({ ...record, status: 'new' })
  }

  /**
   * Patch a feature request (title/description/type/status/urgent/priorityRank/
   * devNotes) and stamp updated_at. Returns the updated record, or null.
   *
   * Approval audit: when the patch moves the item TO 'done' and it isn't already
   * approved, stamp `approved_by = actingUserId` + `approved_at = now()`. When
   * the status moves to anything OTHER than 'done', clear the stamp (keeps it
   * truthful — only currently-done items carry an approver).
   */
  async updateFeatureRequest(id, patch = {}, actingUserId = null) {
    if (!id) return null
    const allowedTypes = ['feature', 'bug', 'improvement']
    const allowedStatuses = [
      'new',
      'planned',
      'planned_not_eom',
      'in_progress',
      'needs_input',
      'brainstorm',
      'shipped',
      'done',
      'wont_do',
    ]
    const title =
      typeof patch.title === 'string' ? patch.title.trim().slice(0, 120) : undefined
    const description =
      typeof patch.description === 'string' ? patch.description.slice(0, 2000) : undefined
    const type =
      typeof patch.type === 'string' && allowedTypes.includes(patch.type) ? patch.type : undefined
    const status =
      typeof patch.status === 'string' && allowedStatuses.includes(patch.status)
        ? patch.status
        : undefined
    const priority =
      typeof patch.priority === 'string' && FEATURE_REQUEST_PRIORITIES.includes(patch.priority)
        ? patch.priority
        : undefined
    const priorityRank =
      typeof patch.priorityRank === 'number' && Number.isFinite(patch.priorityRank)
        ? Math.max(0, Math.floor(patch.priorityRank))
        : undefined
    const devNotes =
      typeof patch.devNotes === 'string' ? patch.devNotes.slice(0, 4000) : undefined
    // Rejection reason from the owner's "Not approved" flow. A non-empty string
    // is a fresh rejection (stamped below alongside the incoming status change);
    // ignored otherwise.
    const reviewNote =
      typeof patch.reviewNote === 'string' && patch.reviewNote.trim()
        ? patch.reviewNote.trim().slice(0, 2000)
        : undefined
    // Clarification loop fields. A string sets (trimmed; '' clears to null so
    // an answered question can be retired); anything else leaves untouched.
    const clarificationQuestion =
      typeof patch.clarificationQuestion === 'string'
        ? patch.clarificationQuestion.trim().slice(0, 2000) || null
        : undefined
    const clarificationAnswer =
      typeof patch.clarificationAnswer === 'string'
        ? patch.clarificationAnswer.trim().slice(0, 2000) || null
        : undefined

    if (
      title === undefined &&
      description === undefined &&
      type === undefined &&
      status === undefined &&
      priority === undefined &&
      priorityRank === undefined &&
      devNotes === undefined &&
      reviewNote === undefined &&
      clarificationQuestion === undefined &&
      clarificationAnswer === undefined
    ) {
      return null
    }

    if (this.pool) {
      // Approval stamp ($9 = the acting user's id). When the new status is
      // 'done' and the row isn't already approved, stamp approved_by/at; when it
      // moves to any other status, clear them; otherwise leave them untouched.
      const result = await this.pool.query(
        `update feature_requests
            set title = coalesce($2, title),
                description = coalesce($3, description),
                type = coalesce($4, type),
                status = coalesce($5, status),
                priority = coalesce($6, priority),
                priority_rank = coalesce($7, priority_rank),
                dev_notes = coalesce($8, dev_notes),
                approved_by = case
                  when $5 = 'done' then coalesce(approved_by, $9)
                  when $5 is not null then null
                  else approved_by
                end,
                approved_at = case
                  when $5 = 'done' then coalesce(approved_at, now())
                  when $5 is not null then null
                  else approved_at
                end,
                review_note = case
                  when $10::text is not null then $10::text
                  when $5 in ('shipped', 'done') then null
                  else review_note
                end,
                reviewed_by = case
                  when $10::text is not null then $9::text
                  when $5 in ('shipped', 'done') then null
                  else reviewed_by
                end,
                reviewed_at = case
                  when $10::text is not null then now()
                  when $5 in ('shipped', 'done') then null
                  else reviewed_at
                end,
                clarification_question = case
                  when $13::boolean then $11::text
                  else clarification_question
                end,
                clarification_answer = case
                  when $14::boolean then $12::text
                  else clarification_answer
                end,
                shipped_at = case
                  when $5 = 'shipped' then now()
                  else shipped_at
                end,
                updated_at = now()
          where id = $1
        returning id, user_id, title, description, type, status, urgent, priority,
                  priority_rank, dev_notes, approved_by, approved_at,
                  review_note, reviewed_by, reviewed_at,
                  clarification_question, clarification_answer, shipped_at,
                  created_at, updated_at`,
        [
          id,
          title ?? null,
          description ?? null,
          type ?? null,
          status ?? null,
          priority ?? null,
          priorityRank ?? null,
          devNotes ?? null,
          actingUserId ?? null,
          reviewNote ?? null,
          clarificationQuestion ?? null,
          clarificationAnswer ?? null,
          clarificationQuestion !== undefined,
          clarificationAnswer !== undefined,
        ],
      )
      if (!result.rowCount) return null
      return AppDataStore.mapFeatureRequest(result.rows[0])
    }

    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.featureRequests)) authState.featureRequests = []
    const existing = authState.featureRequests.find((r) => r.id === id)
    if (!existing) return null
    if (title !== undefined) existing.title = title
    if (description !== undefined) existing.description = description
    if (type !== undefined) existing.type = type
    if (status !== undefined) {
      existing.status = status
      // Mirror the approval-stamp logic on the file backend.
      if (status === 'done') {
        if (!existing.approvedBy) {
          existing.approvedBy = actingUserId ?? null
          existing.approvedAt = nowIso()
        }
      } else {
        existing.approvedBy = null
        existing.approvedAt = null
      }
      // Mirror the shipped_at stamp: every transition INTO shipped re-stamps.
      if (status === 'shipped') existing.shippedAt = nowIso()
    }
    if (priority !== undefined) existing.priority = priority
    if (priorityRank !== undefined) existing.priorityRank = priorityRank
    if (devNotes !== undefined) existing.devNotes = devNotes
    if (clarificationQuestion !== undefined) existing.clarificationQuestion = clarificationQuestion
    if (clarificationAnswer !== undefined) existing.clarificationAnswer = clarificationAnswer
    // Rejection stamp/clear (mirror the pg CASE logic, using the INCOMING
    // status): a fresh non-empty reviewNote stamps the three review_* fields;
    // otherwise re-shipping ('shipped') or approving ('done') clears them.
    if (reviewNote !== undefined) {
      existing.reviewNote = reviewNote
      existing.reviewedBy = actingUserId ?? null
      existing.reviewedAt = nowIso()
    } else if (status === 'shipped' || status === 'done') {
      existing.reviewNote = null
      existing.reviewedBy = null
      existing.reviewedAt = null
    }
    existing.updatedAt = nowIso()
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return AppDataStore.mapFeatureRequest(existing)
  }

  /** Re-rank feature requests by array index (priority_rank = position). */
  async reorderFeatureRequests(orderedIds) {
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) return
    if (this.pool) {
      const client = await this.pool.connect()
      try {
        await client.query('begin')
        for (let index = 0; index < orderedIds.length; index += 1) {
          await client.query(
            `update feature_requests set priority_rank = $2, updated_at = now() where id = $1`,
            [orderedIds[index], index],
          )
        }
        await client.query('commit')
      } catch (error) {
        await client.query('rollback')
        throw error
      } finally {
        client.release()
      }
      return
    }
    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.featureRequests)) authState.featureRequests = []
    const rankById = new Map(orderedIds.map((id, index) => [id, index]))
    for (const r of authState.featureRequests) {
      if (rankById.has(r.id)) {
        r.priorityRank = rankById.get(r.id)
        r.updatedAt = nowIso()
      }
    }
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
  }

  /** Delete a feature request. Returns true if a row was removed. */
  async deleteFeatureRequest(id) {
    if (!id) return false
    if (this.pool) {
      const result = await this.pool.query(`delete from feature_requests where id = $1`, [id])
      return (result.rowCount ?? 0) > 0
    }
    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.featureRequests)) authState.featureRequests = []
    const before = authState.featureRequests.length
    authState.featureRequests = authState.featureRequests.filter((r) => r.id !== id)
    const removed = authState.featureRequests.length < before
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return removed
  }

  /** Load a single feature request by id (for the /refine endpoint). */
  async getFeatureRequest(id) {
    if (!id) return null
    if (this.pool) {
      const result = await this.pool.query(
        `select id, user_id, title, description, type, status, urgent, priority,
                priority_rank, dev_notes, approved_by, approved_at,
                review_note, reviewed_by, reviewed_at, created_at, updated_at
           from feature_requests where id = $1`,
        [id],
      )
      if (!result.rowCount) return null
      return AppDataStore.mapFeatureRequest(result.rows[0])
    }
    const authState = await readJson(localAuthPath)
    const list = Array.isArray(authState.featureRequests) ? authState.featureRequests : []
    const found = list.find((r) => r.id === id)
    return found ? AppDataStore.mapFeatureRequest(found) : null
  }

  /**
   * One `spitball_sessions` row -> the camelCase shape the API speaks. Handles
   * both a pg row (snake_case, jsonb `messages` usually already parsed) and a
   * file-backend record (already camelCase).
   */
  static mapSpitballSession(row) {
    if (!row) return null
    const rawMessages =
      typeof row.messages === 'string' ? safeJsonParse(row.messages) : row.messages
    return {
      id: row.id,
      userId: row.user_id ?? row.userId ?? null,
      status: row.status === 'archived' ? 'archived' : 'active',
      messages: (Array.isArray(rawMessages) ? rawMessages : []).map((message) => ({
        role: message?.role === 'user' ? 'user' : 'assistant',
        text: String(message?.text ?? ''),
        at: message?.at ?? null,
      })),
      summary: row.summary ?? null,
      createdAt: row.created_at
        ? new Date(row.created_at).toISOString()
        : (row.createdAt ?? nowIso()),
      updatedAt: row.updated_at
        ? new Date(row.updated_at).toISOString()
        : (row.updatedAt ?? null),
    }
  }

  /** Normalize turns on the way in: role + text only, each text hard-capped. */
  static cleanSpitballTurns(turns) {
    return (Array.isArray(turns) ? turns : [])
      .filter(
        (turn) =>
          turn &&
          (turn.role === 'user' || turn.role === 'assistant') &&
          typeof turn.text === 'string' &&
          turn.text.trim() !== '',
      )
      .map((turn) => ({
        role: turn.role,
        text: turn.text.trim().slice(0, 8000),
        at: turn.at ?? nowIso(),
      }))
  }

  /**
   * The user's ACTIVE brainstorm session, or null. Creates nothing — the GET
   * endpoint must be able to say "no session yet" without minting an empty row
   * every time the modal is opened and closed.
   */
  async getActiveSpitballSession(userId) {
    if (!userId) return null
    if (this.pool) {
      const result = await this.pool.query(
        `select id, user_id, status, messages, summary, created_at, updated_at
           from spitball_sessions
          where user_id = $1 and status = 'active'
          order by created_at desc
          limit 1`,
        [userId],
      )
      return result.rowCount ? AppDataStore.mapSpitballSession(result.rows[0]) : null
    }
    const authState = await readJson(localAuthPath)
    const list = Array.isArray(authState.spitballSessions) ? authState.spitballSessions : []
    const found = list.filter((s) => s.userId === userId && s.status === 'active').pop()
    return found ? AppDataStore.mapSpitballSession(found) : null
  }

  /** The user's active session, creating an empty one if she has none. */
  async ensureActiveSpitballSession(userId) {
    if (!userId) return null
    const existing = await this.getActiveSpitballSession(userId)
    if (existing) return existing

    const createdAt = nowIso()
    const record = {
      id: `spit-${randomUUID().slice(0, 8)}`,
      userId,
      status: 'active',
      messages: [],
      summary: null,
      createdAt,
      updatedAt: createdAt,
    }

    if (this.pool) {
      // The conflict target is the PARTIAL index, so a second tab racing to
      // open the modal loses harmlessly and reads back the winner's session
      // rather than erroring or minting a second active one.
      const inserted = await this.pool.query(
        `insert into spitball_sessions
           (id, user_id, status, messages, summary, created_at, updated_at)
         values ($1, $2, 'active', $3::jsonb, $4, $5, $6)
         on conflict (user_id) where status = 'active' do nothing`,
        [record.id, record.userId, JSON.stringify(record.messages), record.summary, createdAt, createdAt],
      )
      if (!inserted.rowCount) return this.getActiveSpitballSession(userId)
      return record
    }

    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.spitballSessions)) authState.spitballSessions = []
    authState.spitballSessions.push(record)
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return record
  }

  /**
   * Append turns (the owner's message + the AI's reply) to an active session
   * and return the updated session.
   *
   * Postgres appends IN the row (`messages || $2::jsonb`) rather than
   * read-modify-write, so two turns in flight at once cannot clobber each
   * other. Returns null when the session is gone or already archived.
   */
  async appendSpitballTurn(sessionId, turns) {
    if (!sessionId) return null
    const clean = AppDataStore.cleanSpitballTurns(turns)
    if (clean.length === 0) return null

    if (this.pool) {
      const result = await this.pool.query(
        `update spitball_sessions
            set messages = messages || $2::jsonb,
                updated_at = now()
          where id = $1 and status = 'active'
          returning id, user_id, status, messages, summary, created_at, updated_at`,
        [sessionId, JSON.stringify(clean)],
      )
      return result.rowCount ? AppDataStore.mapSpitballSession(result.rows[0]) : null
    }

    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.spitballSessions)) authState.spitballSessions = []
    const found = authState.spitballSessions.find(
      (s) => s.id === sessionId && s.status === 'active',
    )
    if (!found) return null
    if (!Array.isArray(found.messages)) found.messages = []
    found.messages.push(...clean)
    found.updatedAt = nowIso()
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return AppDataStore.mapSpitballSession(found)
  }

  /**
   * Compaction: fold everything but the most recent `keepRecent` turns into the
   * session's running `summary`. Nothing is ever silently dropped — the old
   * `.slice(-30)` in `spitballChat` forgot the START of a long brainstorm with
   * no trace, which is half of what the client reported.
   *
   * The trim runs in SQL off the row's own value so it stays correct even if a
   * turn landed between the caller's read and this write.
   */
  async compactSpitballSession(sessionId, { summary, keepRecent } = {}) {
    if (!sessionId) return null
    const keep = Math.max(1, Math.min(200, Number(keepRecent) || 12))
    const text = summary === null || summary === undefined ? null : String(summary).slice(0, 6000)

    if (this.pool) {
      const result = await this.pool.query(
        `update spitball_sessions
            set summary = $2,
                messages = coalesce((
                  select jsonb_agg(t.elem order by t.ord)
                    from jsonb_array_elements(spitball_sessions.messages)
                         with ordinality as t(elem, ord)
                   where t.ord > jsonb_array_length(spitball_sessions.messages) - $3::int
                ), '[]'::jsonb),
                updated_at = now()
          where id = $1 and status = 'active'
          returning id, user_id, status, messages, summary, created_at, updated_at`,
        [sessionId, text, keep],
      )
      return result.rowCount ? AppDataStore.mapSpitballSession(result.rows[0]) : null
    }

    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.spitballSessions)) authState.spitballSessions = []
    const found = authState.spitballSessions.find(
      (s) => s.id === sessionId && s.status === 'active',
    )
    if (!found) return null
    found.summary = text
    found.messages = (Array.isArray(found.messages) ? found.messages : []).slice(-keep)
    found.updatedAt = nowIso()
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return AppDataStore.mapSpitballSession(found)
  }

  /**
   * "Start fresh": archive the active session under `summary` so it can inform
   * later brainstorms. Trims each user's archive to the 50 most recent.
   */
  async archiveSpitballSession(sessionId, summary) {
    if (!sessionId) return null
    const text = summary === null || summary === undefined ? null : String(summary).slice(0, 6000)

    if (this.pool) {
      const result = await this.pool.query(
        `update spitball_sessions
            set status = 'archived', summary = $2, updated_at = now()
          where id = $1 and status = 'active'
          returning id, user_id, status, messages, summary, created_at, updated_at`,
        [sessionId, text],
      )
      if (!result.rowCount) return null
      const archived = AppDataStore.mapSpitballSession(result.rows[0])
      await this.pool.query(
        `delete from spitball_sessions
          where user_id = $1
            and status = 'archived'
            and id not in (
              select id from spitball_sessions
              where user_id = $1 and status = 'archived'
              order by updated_at desc
              limit 50
            )`,
        [archived.userId],
      )
      return archived
    }

    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.spitballSessions)) authState.spitballSessions = []
    const found = authState.spitballSessions.find(
      (s) => s.id === sessionId && s.status === 'active',
    )
    if (!found) return null
    found.status = 'archived'
    found.summary = text
    found.updatedAt = nowIso()
    const mine = authState.spitballSessions
      .filter((s) => s.userId === found.userId && s.status === 'archived')
      .sort((a, b) => String(a.updatedAt ?? '').localeCompare(String(b.updatedAt ?? '')))
    if (mine.length > 50) {
      const drop = new Set(mine.slice(0, mine.length - 50).map((s) => s.id))
      authState.spitballSessions = authState.spitballSessions.filter((s) => !drop.has(s.id))
    }
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return AppDataStore.mapSpitballSession(found)
  }

  /**
   * Cross-session memory: the summaries of this user's archived brainstorms,
   * newest first. Sessions archived without a summary are skipped — there is
   * nothing to recall.
   */
  async listSpitballSummaries(userId, limit = 5) {
    if (!userId) return []
    const cap = Math.max(1, Math.min(20, Number(limit) || 5))

    if (this.pool) {
      const result = await this.pool.query(
        `select id, summary, updated_at
           from spitball_sessions
          where user_id = $1
            and status = 'archived'
            and summary is not null
            and summary <> ''
          order by updated_at desc
          limit $2`,
        [userId, cap],
      )
      return result.rows.map((row) => ({
        id: row.id,
        summary: row.summary,
        at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      }))
    }

    const authState = await readJson(localAuthPath)
    const list = Array.isArray(authState.spitballSessions) ? authState.spitballSessions : []
    return (
      list
        .map((session, index) => ({ session, index }))
        .filter(
          ({ session }) =>
            session.userId === userId && session.status === 'archived' && session.summary,
        )
        // Two sessions archived inside the same millisecond would otherwise tie
        // and fall back to insertion order, i.e. OLDEST first — the opposite of
        // the contract. Later position in the file breaks the tie.
        .sort(
          (a, b) =>
            String(b.session.updatedAt ?? '').localeCompare(String(a.session.updatedAt ?? '')) ||
            b.index - a.index,
        )
        .slice(0, cap)
        .map(({ session }) => ({
          id: session.id,
          summary: session.summary,
          at: session.updatedAt ?? null,
        }))
    )
  }

  /** Suggestion keys this user has dismissed (assistant insights). */
  async listDismissedSuggestions(userId) {
    if (this.pool) {
      const result = await this.pool.query(
        `select suggestion_key from assistant_dismissed_suggestions where user_id = $1`,
        [userId],
      )
      return result.rows.map((row) => row.suggestion_key)
    }
    const authState = await readJson(localAuthPath)
    return (authState.dismissedSuggestions ?? [])
      .filter((entry) => entry.userId === userId)
      .map((entry) => entry.suggestionKey)
  }

  /** Permanently dismiss one assistant suggestion for this user. */
  async dismissSuggestion(userId, suggestionKey) {
    const key = String(suggestionKey ?? '').slice(0, 300)
    if (!userId || !key) return

    if (this.pool) {
      await this.pool.query(
        `insert into assistant_dismissed_suggestions (user_id, suggestion_key)
         values ($1, $2)
         on conflict (user_id, suggestion_key) do nothing`,
        [userId, key],
      )
      return
    }

    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.dismissedSuggestions)) authState.dismissedSuggestions = []
    const exists = authState.dismissedSuggestions.some(
      (entry) => entry.userId === userId && entry.suggestionKey === key,
    )
    if (!exists) {
      authState.dismissedSuggestions.push({
        userId,
        suggestionKey: key,
        dismissedAt: nowIso(),
      })
      await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    }
  }

  /** Un-dismiss (restore) one previously-dismissed key for this user. */
  async removeDismissedSuggestion(userId, suggestionKey) {
    const key = String(suggestionKey ?? '').slice(0, 300)
    if (!userId || !key) return

    if (this.pool) {
      await this.pool.query(
        `delete from assistant_dismissed_suggestions where user_id = $1 and suggestion_key = $2`,
        [userId, key],
      )
      return
    }

    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.dismissedSuggestions)) return
    const before = authState.dismissedSuggestions.length
    authState.dismissedSuggestions = authState.dismissedSuggestions.filter(
      (entry) => !(entry.userId === userId && entry.suggestionKey === key),
    )
    if (authState.dismissedSuggestions.length !== before) {
      await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    }
  }

  /**
   * Persisted assistant conversation (Phase 3). Returns the user's chat
   * turns oldest-first, capped to the most recent `limit` rows. Only
   * role + text are stored.
   */
  async getAssistantMessages(userId, limit = 100) {
    if (!userId) return []
    const cap = Math.max(1, Math.min(500, Number(limit) || 100))

    if (this.pool) {
      const result = await this.pool.query(
        `select id, role, text, created_at
           from assistant_messages
          where user_id = $1
          order by created_at desc
          limit $2`,
        [userId, cap],
      )
      return result.rows
        .map((row) => ({
          id: row.id,
          role: row.role,
          text: row.text,
          createdAt: row.created_at ? new Date(row.created_at).toISOString() : nowIso(),
        }))
        .reverse()
    }

    const authState = await readJson(localAuthPath)
    return (authState.assistantMessages ?? [])
      .filter((entry) => entry.userId === userId)
      .slice(-cap)
      .map((entry) => ({
        id: entry.id,
        role: entry.role,
        text: entry.text,
        createdAt: entry.createdAt,
      }))
  }

  /**
   * Append one or more turns to a user's persisted conversation. Each entry
   * is `{ role: 'user'|'assistant', text }`. Trims the stored history to the
   * most recent 200 turns per user so it can't grow without bound.
   */
  async appendAssistantMessages(userId, entries) {
    if (!userId || !Array.isArray(entries) || entries.length === 0) return
    const clean = entries
      .filter(
        (entry) =>
          entry &&
          (entry.role === 'user' || entry.role === 'assistant') &&
          typeof entry.text === 'string' &&
          entry.text.trim() !== '',
      )
      .map((entry) => ({
        id: `amsg-${randomUUID().slice(0, 8)}`,
        userId,
        role: entry.role,
        text: String(entry.text).slice(0, 8000),
        createdAt: nowIso(),
      }))
    if (clean.length === 0) return

    if (this.pool) {
      for (const entry of clean) {
        await this.pool.query(
          `insert into assistant_messages (id, user_id, role, text, created_at)
           values ($1, $2, $3, $4, $5)`,
          [entry.id, entry.userId, entry.role, entry.text, entry.createdAt],
        )
      }
      // Keep only the most recent 200 turns for this user.
      await this.pool.query(
        `delete from assistant_messages
          where user_id = $1
            and id not in (
              select id from assistant_messages
              where user_id = $1
              order by created_at desc
              limit 200
            )`,
        [userId],
      )
      return
    }

    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.assistantMessages)) authState.assistantMessages = []
    authState.assistantMessages.push(...clean)
    // Trim to the most recent 200 turns for this user, preserving others.
    const mine = authState.assistantMessages.filter((entry) => entry.userId === userId)
    if (mine.length > 200) {
      const keep = new Set(mine.slice(-200).map((entry) => entry.id))
      authState.assistantMessages = authState.assistantMessages.filter(
        (entry) => entry.userId !== userId || keep.has(entry.id),
      )
    }
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
  }

  /** Clear a user's persisted assistant conversation. */
  async clearAssistantMessages(userId) {
    if (!userId) return
    if (this.pool) {
      await this.pool.query(`delete from assistant_messages where user_id = $1`, [userId])
      return
    }
    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.assistantMessages)) return
    authState.assistantMessages = authState.assistantMessages.filter(
      (entry) => entry.userId !== userId,
    )
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
  }

  /**
   * Weekly-digest dedupe (Phase 3). Returns the ISO week (yyyy-mm-dd Monday)
   * of the last digest sent to this user, or null if none.
   */
  async getLastDigestWeek(userId) {
    if (!userId) return null
    if (this.pool) {
      const result = await this.pool.query(
        `select last_week_start from assistant_digest_state where user_id = $1`,
        [userId],
      )
      return result.rowCount ? result.rows[0].last_week_start : null
    }
    const authState = await readJson(localAuthPath)
    const entry = (authState.assistantDigestState ?? []).find((row) => row.userId === userId)
    return entry ? entry.lastWeekStart : null
  }

  /** Record that this user's digest for `weekStart` has been sent. */
  async markDigestSent(userId, weekStart) {
    if (!userId || !weekStart) return
    if (this.pool) {
      await this.pool.query(
        `insert into assistant_digest_state (user_id, last_week_start, updated_at)
         values ($1, $2, now())
         on conflict (user_id) do update
           set last_week_start = excluded.last_week_start, updated_at = now()`,
        [userId, weekStart],
      )
      return
    }
    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.assistantDigestState)) authState.assistantDigestState = []
    const existing = authState.assistantDigestState.find((row) => row.userId === userId)
    if (existing) {
      existing.lastWeekStart = weekStart
      existing.updatedAt = nowIso()
    } else {
      authState.assistantDigestState.push({
        userId,
        lastWeekStart: weekStart,
        updatedAt: nowIso(),
      })
    }
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
  }

  /**
   * Voice memory (V2): save one durable fact the owner told the voice agent.
   * Trims the store to the most recent 200 facts. Returns the record.
   */
  async addVoiceMemory(userId, fact, source = 'voice') {
    const text = String(fact ?? '').trim().slice(0, 500)
    if (!userId || !text) return null
    const record = {
      id: `vmem-${randomUUID().slice(0, 8)}`,
      userId,
      fact: text,
      source: String(source).slice(0, 40),
      createdAt: nowIso(),
    }

    if (this.pool) {
      await this.pool.query(
        `insert into voice_memories (id, user_id, fact, source, created_at)
         values ($1, $2, $3, $4, $5)`,
        [record.id, record.userId, record.fact, record.source, record.createdAt],
      )
      await this.pool.query(
        `delete from voice_memories
          where user_id = $1
            and id not in (
              select id from voice_memories
              where user_id = $1
              order by created_at desc
              limit 200
            )`,
        [userId],
      )
      return record
    }

    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.voiceMemories)) authState.voiceMemories = []
    authState.voiceMemories.push(record)
    const mine = authState.voiceMemories.filter((m) => m.userId === userId)
    if (mine.length > 200) {
      const keep = new Set(mine.slice(-200).map((m) => m.id))
      authState.voiceMemories = authState.voiceMemories.filter(
        (m) => m.userId !== userId || keep.has(m.id),
      )
    }
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return record
  }

  /** Voice memory (V2): newest-first facts for this user. */
  async listVoiceMemories(userId, limit = 50) {
    if (!userId) return []
    const cap = Math.max(1, Math.min(200, Number(limit) || 50))

    if (this.pool) {
      const result = await this.pool.query(
        `select id, fact, source, created_at
           from voice_memories
          where user_id = $1
          order by created_at desc
          limit $2`,
        [userId, cap],
      )
      return result.rows.map((row) => ({
        id: row.id,
        fact: row.fact,
        source: row.source,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : nowIso(),
      }))
    }

    const authState = await readJson(localAuthPath)
    return (authState.voiceMemories ?? [])
      .filter((m) => m.userId === userId)
      .slice(-cap)
      .reverse()
      .map((m) => ({ id: m.id, fact: m.fact, source: m.source, createdAt: m.createdAt }))
  }

  /**
   * Voice transcripts (V2): persist one post-call summary + turns. Keeps the
   * most recent 50 calls. `transcript` is an array of {role, message}.
   */
  async saveVoiceTranscript({ conversationId, summary, transcript }) {
    const convId = String(conversationId ?? '').slice(0, 120)
    if (!convId) return null
    const record = {
      id: `vcall-${randomUUID().slice(0, 8)}`,
      conversationId: convId,
      summary: String(summary ?? '').slice(0, 4000),
      transcript: (Array.isArray(transcript) ? transcript : [])
        .slice(0, 400)
        .map((turn) => ({
          role: turn?.role === 'user' ? 'user' : 'agent',
          message: String(turn?.message ?? '').slice(0, 2000),
        })),
      createdAt: nowIso(),
    }

    if (this.pool) {
      await this.pool.query(
        `insert into voice_transcripts (id, conversation_id, summary, transcript, created_at)
         values ($1, $2, $3, $4, $5)`,
        [record.id, record.conversationId, record.summary, JSON.stringify(record.transcript), record.createdAt],
      )
      await this.pool.query(
        `delete from voice_transcripts
          where id not in (
            select id from voice_transcripts order by created_at desc limit 50
          )`,
      )
      return record
    }

    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.voiceTranscripts)) authState.voiceTranscripts = []
    authState.voiceTranscripts.push(record)
    if (authState.voiceTranscripts.length > 50) {
      authState.voiceTranscripts = authState.voiceTranscripts.slice(-50)
    }
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return record
  }

  /**
   * Sales-tax figures for one client + period (Client Recap). Returns the
   * record or null. Owner-only financial data — caller enforces auth.
   */
  async getSalesTaxRecord(clientId, period) {
    if (!clientId || !period) return null
    if (this.pool) {
      const result = await this.pool.query(
        `select client_id, period, taxable_sales, tax_collected, tax_owed, notes, updated_by, updated_at
           from sales_tax_records where client_id = $1 and period = $2`,
        [clientId, period],
      )
      if (!result.rowCount) return null
      const row = result.rows[0]
      const num = (v) => (v == null ? null : Number(v))
      return {
        clientId: row.client_id,
        period: row.period,
        taxableSales: num(row.taxable_sales),
        taxCollected: num(row.tax_collected),
        taxOwed: num(row.tax_owed),
        notes: row.notes ?? '',
        updatedBy: row.updated_by ?? null,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      }
    }
    const authState = await readJson(localAuthPath)
    return (
      (authState.salesTaxRecords ?? []).find(
        (r) => r.clientId === clientId && r.period === period,
      ) ?? null
    )
  }

  /**
   * Upsert sales-tax figures for a client + period. Figures are non-negative
   * numbers or null (cleared). Returns the saved record. Owner-only — caller
   * enforces auth.
   */
  async upsertSalesTaxRecord({ clientId, period, taxableSales, taxCollected, taxOwed, notes, updatedBy }) {
    if (!clientId || !period) return null
    const money = (v) => {
      if (v === null || v === undefined || v === '') return null
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0) return null
      return Math.round(n * 100) / 100
    }
    const record = {
      clientId,
      period,
      taxableSales: money(taxableSales),
      taxCollected: money(taxCollected),
      taxOwed: money(taxOwed),
      notes: String(notes ?? '').slice(0, 2000),
      updatedBy: updatedBy ?? null,
      updatedAt: nowIso(),
    }

    if (this.pool) {
      await this.pool.query(
        `insert into sales_tax_records
           (id, client_id, period, taxable_sales, tax_collected, tax_owed, notes, updated_by, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, now())
         on conflict (client_id, period) do update set
           taxable_sales = excluded.taxable_sales,
           tax_collected = excluded.tax_collected,
           tax_owed = excluded.tax_owed,
           notes = excluded.notes,
           updated_by = excluded.updated_by,
           updated_at = now()`,
        [
          `stax-${randomUUID().slice(0, 8)}`,
          clientId,
          period,
          record.taxableSales,
          record.taxCollected,
          record.taxOwed,
          record.notes,
          record.updatedBy,
        ],
      )
      return record
    }

    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.salesTaxRecords)) authState.salesTaxRecords = []
    const existing = authState.salesTaxRecords.find(
      (r) => r.clientId === clientId && r.period === period,
    )
    if (existing) {
      Object.assign(existing, record)
    } else {
      authState.salesTaxRecords.push({ id: `stax-${randomUUID().slice(0, 8)}`, ...record })
    }
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return record
  }

  // ---- Client notes: a timestamped, attributed, append-only log per client ----
  //
  // Endpoint-managed (NOT part of the bulk /api/app-data write), like sales-tax
  // records — so staff (who can't do the owner-only bulk save) can still add
  // notes, and notes can't be clobbered by an autosave. Stored in auth-state on
  // the file backend, client_notes on pg. Always returned newest-first.

  /** Notes for one client, newest first. */
  async listClientNotes(clientId) {
    if (!clientId) return []
    if (this.pool) {
      const result = await this.pool.query(
        `select id, client_id, author_id, author_name, body, created_at
           from client_notes where client_id = $1 order by created_at desc`,
        [clientId],
      )
      return result.rows.map((row) => ({
        id: row.id,
        clientId: row.client_id,
        authorId: row.author_id ?? null,
        authorName: row.author_name ?? null,
        body: row.body,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      }))
    }
    const authState = await readJson(localAuthPath)
    const list = Array.isArray(authState.clientNotes) ? authState.clientNotes : []
    return list
      .filter((note) => note.clientId === clientId)
      .slice()
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }

  /** Append a note to a client's log. Returns the created note. */
  async addClientNote(clientId, { authorId, authorName, body } = {}) {
    if (!clientId) return null
    const clean = String(body ?? '').trim().slice(0, 5000)
    if (!clean) return null
    const note = {
      id: `cnote-${randomUUID().slice(0, 8)}`,
      clientId,
      authorId: authorId ?? null,
      authorName: authorName ?? null,
      body: clean,
      createdAt: nowIso(),
    }
    if (this.pool) {
      await this.pool.query(
        `insert into client_notes (id, client_id, author_id, author_name, body, created_at)
         values ($1, $2, $3, $4, $5, now())`,
        [note.id, note.clientId, note.authorId, note.authorName, note.body],
      )
      return note
    }
    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.clientNotes)) authState.clientNotes = []
    authState.clientNotes.push(note)
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return note
  }

  /** Look up a single note by id (used to authorize deletes). */
  async getClientNote(noteId) {
    if (!noteId) return null
    if (this.pool) {
      const result = await this.pool.query(
        `select id, client_id, author_id, author_name, body, created_at
           from client_notes where id = $1`,
        [noteId],
      )
      if (!result.rowCount) return null
      const row = result.rows[0]
      return {
        id: row.id,
        clientId: row.client_id,
        authorId: row.author_id ?? null,
        authorName: row.author_name ?? null,
        body: row.body,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
      }
    }
    const authState = await readJson(localAuthPath)
    const list = Array.isArray(authState.clientNotes) ? authState.clientNotes : []
    return list.find((note) => note.id === noteId) ?? null
  }

  /** Delete a note by id. Returns true if a row was removed. */
  async deleteClientNote(noteId) {
    if (!noteId) return false
    if (this.pool) {
      const result = await this.pool.query(`delete from client_notes where id = $1`, [noteId])
      return (result.rowCount ?? 0) > 0
    }
    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.clientNotes)) authState.clientNotes = []
    const before = authState.clientNotes.length
    authState.clientNotes = authState.clientNotes.filter((note) => note.id !== noteId)
    const removed = authState.clientNotes.length < before
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return removed
  }

  // ---- Item-level deletion requests (staff request → owner approves) ----
  //
  // Endpoint-managed (NOT part of the bulk /api/app-data write), like client
  // notes — so staff can file a request without the owner-only bulk save and
  // requests can't be clobbered by an autosave. Stored in auth-state on the
  // file backend, item_deletion_requests on pg. Always returned newest-first.

  /** Every pending item-deletion request, newest first. */
  async listItemDeletionRequests() {
    if (this.pool) {
      const result = await this.pool.query(
        `select id, client_id, checklist_id, item_id, sub_item_id, sub_sub_item_id,
                label, requested_by, requested_by_name, requested_at
           from item_deletion_requests order by requested_at desc`,
      )
      return result.rows.map((row) => ({
        id: row.id,
        clientId: row.client_id,
        checklistId: row.checklist_id,
        itemId: row.item_id,
        subItemId: row.sub_item_id ?? null,
        subSubItemId: row.sub_sub_item_id ?? null,
        label: row.label,
        requestedBy: row.requested_by ?? null,
        requestedByName: row.requested_by_name ?? null,
        requestedAt: row.requested_at ? new Date(row.requested_at).toISOString() : null,
      }))
    }
    const authState = await readJson(localAuthPath)
    const list = Array.isArray(authState.itemDeletionRequests)
      ? authState.itemDeletionRequests
      : []
    return list
      .map((req) => ({
        id: req.id,
        clientId: req.clientId,
        checklistId: req.checklistId,
        itemId: req.itemId,
        subItemId: req.subItemId ?? null,
        subSubItemId: req.subSubItemId ?? null,
        label: req.label,
        requestedBy: req.requestedBy ?? null,
        requestedByName: req.requestedByName ?? null,
        requestedAt: req.requestedAt ?? null,
      }))
      .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))
  }

  /** Look up a single item-deletion request by id (used to approve/reject). */
  async getItemDeletionRequest(id) {
    if (!id) return null
    const all = await this.listItemDeletionRequests()
    return all.find((req) => req.id === id) ?? null
  }

  /** File an item-deletion request. Returns the created request. */
  async createItemDeletionRequest({
    clientId,
    checklistId,
    itemId,
    subItemId,
    subSubItemId,
    label,
    requestedBy,
    requestedByName,
  } = {}) {
    if (!clientId || !checklistId || !itemId) return null
    const request = {
      id: `idr-${randomUUID().slice(0, 8)}`,
      clientId,
      checklistId,
      itemId,
      subItemId: subItemId ?? null,
      subSubItemId: subSubItemId ?? null,
      label: String(label ?? '').slice(0, 500),
      requestedBy: requestedBy ?? null,
      requestedByName: requestedByName ?? null,
      requestedAt: nowIso(),
    }
    if (this.pool) {
      await this.pool.query(
        `insert into item_deletion_requests
           (id, client_id, checklist_id, item_id, sub_item_id, sub_sub_item_id,
            label, requested_by, requested_by_name, requested_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
        [
          request.id,
          request.clientId,
          request.checklistId,
          request.itemId,
          request.subItemId,
          request.subSubItemId,
          request.label,
          request.requestedBy,
          request.requestedByName,
        ],
      )
      return request
    }
    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.itemDeletionRequests)) authState.itemDeletionRequests = []
    authState.itemDeletionRequests.push(request)
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return request
  }

  /** Delete an item-deletion request by id. Returns true if a row was removed. */
  async deleteItemDeletionRequest(id) {
    if (!id) return false
    if (this.pool) {
      const result = await this.pool.query(
        `delete from item_deletion_requests where id = $1`,
        [id],
      )
      return (result.rowCount ?? 0) > 0
    }
    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.itemDeletionRequests)) authState.itemDeletionRequests = []
    const before = authState.itemDeletionRequests.length
    authState.itemDeletionRequests = authState.itemDeletionRequests.filter((req) => req.id !== id)
    const removed = authState.itemDeletionRequests.length < before
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return removed
  }

  // ---- Task DETAILS meta edit (title / due date / assignee) ----
  //
  // Direct apply of a checklist's own fields, used by the dedicated
  // PATCH /api/checklists/:id endpoint (owner / creator direct edits and the
  // approve step of a routed edit). Only the three routable detail fields are
  // touched — items and every other column are left alone. Returns the updated
  // checklist (via read()) or null when the id doesn't exist.
  async updateChecklistMeta(checklistId, patch = {}) {
    if (!checklistId) return null
    const { title, dueDate, assigneeId, categoryId } = patch ?? {}

    if (this.pool) {
      const setClauses = []
      const params = [checklistId]
      if (title !== undefined) {
        params.push(String(title))
        setClauses.push(`title = $${params.length}`)
      }
      if (dueDate !== undefined) {
        params.push(dueDate === '' || dueDate === null ? null : dueDate)
        setClauses.push(`due_date = $${params.length}`)
      }
      if (assigneeId !== undefined) {
        params.push(assigneeId === '' || assigneeId === null ? null : assigneeId)
        setClauses.push(`assignee_id = $${params.length}`)
      }
      // categoryId moves the checklist between board columns. Unlike the fields
      // above, an explicit null/'' is meaningful (→ Uncategorized), so it's
      // written through rather than ignored.
      if (categoryId !== undefined) {
        params.push(categoryId === '' || categoryId === null ? null : String(categoryId))
        setClauses.push(`category_id = $${params.length}`)
      }
      if (setClauses.length === 0) {
        const data = await this.read()
        return data.checklists.find((c) => c.id === checklistId) ?? null
      }
      setClauses.push('updated_at = now()')
      const result = await this.pool.query(
        `update checklists set ${setClauses.join(', ')} where id = $1 returning id`,
        params,
      )
      if (!result.rowCount) return null
      const data = await this.read()
      return data.checklists.find((c) => c.id === checklistId) ?? null
    }

    const data = await readJson(localDataPath)
    let updated = null
    data.checklists = (data.checklists ?? []).map((checklist) => {
      if (checklist.id !== checklistId) return checklist
      const next = { ...checklist }
      if (title !== undefined) next.title = String(title)
      if (dueDate !== undefined && dueDate !== '' && dueDate !== null) next.dueDate = dueDate
      if (assigneeId !== undefined && assigneeId !== '' && assigneeId !== null) {
        next.assigneeId = assigneeId
      }
      // categoryId: an explicit null/'' clears it (→ Uncategorized), so it's
      // applied even when empty (unlike due/assignee above).
      if (categoryId !== undefined) {
        next.categoryId = categoryId === '' || categoryId === null ? null : categoryId
      }
      updated = next
      return next
    })
    if (!updated) return null
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return updated
  }

  // ---- Pending task edits (non-creator edit → creator/owner approves) ----
  //
  // Endpoint-managed (NOT part of the bulk /api/app-data write), like item
  // deletion requests — so staff can file an edit without the owner-only bulk
  // save and edits can't be clobbered by an autosave. Stored in auth-state on
  // the file backend, pending_task_edits on pg. Always returned newest-first.

  /**
   * Pending task edits visible to `session`. The owner sees all; everyone else
   * sees only edits routed to them (`approver_id = self`), mirroring
   * listItemDeletionRequests' owner-vs-scoped rule.
   */
  async listPendingTaskEdits(session) {
    const isOwner = session?.user?.role === 'owner'
    const selfId = session?.user?.id ?? null
    let all
    if (this.pool) {
      const result = await this.pool.query(
        `select id, checklist_id, item_id, scope, proposed, summary,
                requested_by, requested_by_name, approver_id, requested_at
           from pending_task_edits order by requested_at desc`,
      )
      all = result.rows.map((row) => ({
        id: row.id,
        checklistId: row.checklist_id,
        itemId: row.item_id ?? null,
        scope: row.scope,
        proposed:
          row.proposed && typeof row.proposed === 'object' ? row.proposed : {},
        summary: row.summary ?? '',
        requestedBy: row.requested_by ?? null,
        requestedByName: row.requested_by_name ?? null,
        approverId: row.approver_id ?? null,
        requestedAt: row.requested_at ? new Date(row.requested_at).toISOString() : null,
      }))
    } else {
      const authState = await readJson(localAuthPath)
      const list = Array.isArray(authState.pendingTaskEdits) ? authState.pendingTaskEdits : []
      all = list
        .map((req) => ({
          id: req.id,
          checklistId: req.checklistId,
          itemId: req.itemId ?? null,
          scope: req.scope,
          proposed: req.proposed && typeof req.proposed === 'object' ? req.proposed : {},
          summary: req.summary ?? '',
          requestedBy: req.requestedBy ?? null,
          requestedByName: req.requestedByName ?? null,
          approverId: req.approverId ?? null,
          requestedAt: req.requestedAt ?? null,
        }))
        .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))
    }
    if (isOwner) return all
    return all.filter((req) => req.approverId === selfId)
  }

  /** Look up a single pending task edit by id (used to approve/reject). */
  async getPendingTaskEdit(id) {
    if (!id) return null
    if (this.pool) {
      const result = await this.pool.query(
        `select id, checklist_id, item_id, scope, proposed, summary,
                requested_by, requested_by_name, approver_id, requested_at
           from pending_task_edits where id = $1`,
        [id],
      )
      const row = result.rows[0]
      if (!row) return null
      return {
        id: row.id,
        checklistId: row.checklist_id,
        itemId: row.item_id ?? null,
        scope: row.scope,
        proposed: row.proposed && typeof row.proposed === 'object' ? row.proposed : {},
        summary: row.summary ?? '',
        requestedBy: row.requested_by ?? null,
        requestedByName: row.requested_by_name ?? null,
        approverId: row.approver_id ?? null,
        requestedAt: row.requested_at ? new Date(row.requested_at).toISOString() : null,
      }
    }
    const authState = await readJson(localAuthPath)
    const list = Array.isArray(authState.pendingTaskEdits) ? authState.pendingTaskEdits : []
    const req = list.find((r) => r.id === id)
    if (!req) return null
    return {
      id: req.id,
      checklistId: req.checklistId,
      itemId: req.itemId ?? null,
      scope: req.scope,
      proposed: req.proposed && typeof req.proposed === 'object' ? req.proposed : {},
      summary: req.summary ?? '',
      requestedBy: req.requestedBy ?? null,
      requestedByName: req.requestedByName ?? null,
      approverId: req.approverId ?? null,
      requestedAt: req.requestedAt ?? null,
    }
  }

  /** File a pending task edit. Returns the created request. */
  async createPendingTaskEdit({
    checklistId,
    itemId,
    scope,
    proposed,
    summary,
    requestedBy,
    requestedByName,
    approverId,
  } = {}) {
    if (!checklistId || !scope) return null
    const request = {
      id: `pte-${randomUUID().slice(0, 8)}`,
      checklistId,
      itemId: itemId ?? null,
      scope,
      proposed: proposed && typeof proposed === 'object' ? proposed : {},
      summary: String(summary ?? '').slice(0, 500),
      requestedBy: requestedBy ?? null,
      requestedByName: requestedByName ?? null,
      approverId: approverId ?? null,
      requestedAt: nowIso(),
    }
    if (this.pool) {
      await this.pool.query(
        `insert into pending_task_edits
           (id, checklist_id, item_id, scope, proposed, summary,
            requested_by, requested_by_name, approver_id, requested_at)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, now())`,
        [
          request.id,
          request.checklistId,
          request.itemId,
          request.scope,
          JSON.stringify(request.proposed),
          request.summary,
          request.requestedBy,
          request.requestedByName,
          request.approverId,
        ],
      )
      return request
    }
    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.pendingTaskEdits)) authState.pendingTaskEdits = []
    authState.pendingTaskEdits.push(request)
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return request
  }

  /** Delete a pending task edit by id. Returns true if a row was removed. */
  async deletePendingTaskEdit(id) {
    if (!id) return false
    if (this.pool) {
      const result = await this.pool.query(`delete from pending_task_edits where id = $1`, [id])
      return (result.rowCount ?? 0) > 0
    }
    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.pendingTaskEdits)) authState.pendingTaskEdits = []
    const before = authState.pendingTaskEdits.length
    authState.pendingTaskEdits = authState.pendingTaskEdits.filter((req) => req.id !== id)
    const removed = authState.pendingTaskEdits.length < before
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return removed
  }

  // ---- Quiet skip: the instance marker + the audit trail ----
  //
  // Two stores, on purpose. The MARKER (`checklists.skipped_at/skipped_by`)
  // rides with the checklist row because it is a property of that instance and
  // has to survive the owner's bulk save. The RECORD (`checklist_skips` on pg,
  // `authState.checklistSkips` on the file backend) is endpoint-managed like
  // pending_task_edits, so staff can file one without the owner-only bulk save
  // and a stale tab can never clobber the history. The record is kept forever;
  // reviewing stamps it rather than deleting it.

  /**
   * Stamp an instance as skipped for this cycle. Refuses a task that is already
   * skipped or already in the recycle bin, so a double-submit cannot produce two
   * skip records for one cycle. Returns the updated checklist, or null.
   */
  async skipChecklistInstance(checklistId, userId) {
    if (!checklistId) return null
    if (this.pool) {
      const result = await this.pool.query(
        `update checklists set skipped_at = now(), skipped_by = $2
         where id = $1 and deleted_at is null and skipped_at is null
         returning id`,
        [checklistId, userId ?? null],
      )
      if ((result.rowCount ?? 0) === 0) return null
      const data = await this.read()
      return (data.checklists ?? []).find((checklist) => checklist.id === checklistId) ?? null
    }
    const data = await readJson(localDataPath)
    const target = (data.checklists ?? []).find((checklist) => checklist.id === checklistId)
    if (!target || target.deletedAt || target.skippedAt) return null
    target.skippedAt = nowIso()
    target.skippedBy = userId ?? null
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return target
  }

  /**
   * Every skip record, newest first. Not scoped: the only caller is the
   * owner-only dashboard endpoint, which does its own role check — a scoped
   * variant with no scoped caller would be a second rule to keep honest.
   */
  async listChecklistSkips() {
    if (this.pool) {
      const result = await this.pool.query(
        `select id, checklist_id, template_id, client_id, title, skipped_by, skipped_by_name,
                skipped_at, reason_category, reason_note, reviewed_by, reviewed_at
           from checklist_skips order by skipped_at desc`,
      )
      return result.rows.map(mapChecklistSkipRow)
    }
    const authState = await readJson(localAuthPath)
    const list = Array.isArray(authState.checklistSkips) ? authState.checklistSkips : []
    return [...list]
      .map(normalizeChecklistSkip)
      .sort((a, b) => String(b.skippedAt).localeCompare(String(a.skippedAt)))
  }

  /** File a skip record. Returns the created record. */
  async createChecklistSkip({
    checklistId,
    templateId,
    clientId,
    title,
    skippedBy,
    skippedByName,
    reasonCategory,
    reasonNote,
  } = {}) {
    if (!checklistId || !reasonCategory || !reasonNote) return null
    const record = {
      id: `skip-${randomUUID().slice(0, 8)}`,
      checklistId,
      templateId: templateId ?? null,
      clientId: clientId ?? null,
      // Snapshot the title: the record outlives renames and deletions.
      title: String(title ?? '').slice(0, 300),
      skippedBy: skippedBy ?? null,
      skippedByName: skippedByName ?? null,
      skippedAt: nowIso(),
      reasonCategory,
      reasonNote: String(reasonNote),
      reviewedBy: null,
      reviewedAt: null,
    }
    if (this.pool) {
      await this.pool.query(
        `insert into checklist_skips
           (id, checklist_id, template_id, client_id, title, skipped_by, skipped_by_name,
            skipped_at, reason_category, reason_note)
         values ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9)`,
        [
          record.id,
          record.checklistId,
          record.templateId,
          record.clientId,
          record.title,
          record.skippedBy,
          record.skippedByName,
          record.reasonCategory,
          record.reasonNote,
        ],
      )
      return record
    }
    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.checklistSkips)) authState.checklistSkips = []
    authState.checklistSkips.push(record)
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return record
  }

  /**
   * Mark a skip reviewed — the owner has either decided it was legitimate or
   * had the conversation. Clears it off her dashboard and NOTHING else: the row
   * stays forever. Idempotent: re-reviewing an already-reviewed skip returns
   * null rather than re-stamping someone else's decision.
   */
  async reviewChecklistSkip(skipId, reviewerId) {
    if (!skipId) return null
    if (this.pool) {
      const result = await this.pool.query(
        `update checklist_skips set reviewed_by = $2, reviewed_at = now()
         where id = $1 and reviewed_at is null
         returning id, checklist_id, template_id, client_id, title, skipped_by, skipped_by_name,
                   skipped_at, reason_category, reason_note, reviewed_by, reviewed_at`,
        [skipId, reviewerId ?? null],
      )
      const row = result.rows[0]
      return row ? mapChecklistSkipRow(row) : null
    }
    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.checklistSkips)) authState.checklistSkips = []
    const record = authState.checklistSkips.find((entry) => entry?.id === skipId)
    if (!record || record.reviewedAt) return null
    record.reviewedBy = reviewerId ?? null
    record.reviewedAt = nowIso()
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return normalizeChecklistSkip(record)
  }

  // ---- Active Checklists board: service categories (the columns) ----
  //
  // Endpoint-managed (NOT part of the bulk /api/app-data write), like
  // sales-tax records — so the board's columns can't be clobbered by an
  // autosave. Stored in auth-state on the file backend, service_categories on
  // pg. Always returned sorted by sort_order then name.

  /** Every service category, sorted for left-to-right column display. */
  async listServiceCategories() {
    if (this.pool) {
      const result = await this.pool.query(
        `select id, name, sort_order from service_categories order by sort_order asc, name asc`,
      )
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        sortOrder: Number(row.sort_order) || 0,
      }))
    }
    const authState = await readJson(localAuthPath)
    const list = Array.isArray(authState.serviceCategories) ? authState.serviceCategories : null
    if (!list || list.length === 0) {
      // Seed once (mirrors the pg seed in initialize()).
      const seeded = SEED_SERVICE_CATEGORIES.map((name, index) => ({
        id: `cat-${randomUUID().slice(0, 8)}`,
        name,
        sortOrder: index,
      }))
      authState.serviceCategories = seeded
      await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
      return seeded
    }
    return [...list]
      .map((c) => ({ id: c.id, name: c.name, sortOrder: Number(c.sortOrder) || 0 }))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
  }

  /** Create a category at the end of the column order. Returns it. */
  async createServiceCategory(name) {
    const clean = String(name ?? '').trim().slice(0, 80)
    if (!clean) return null
    const existing = await this.listServiceCategories()
    const sortOrder = existing.length
    const category = { id: `cat-${randomUUID().slice(0, 8)}`, name: clean, sortOrder }
    if (this.pool) {
      await this.pool.query(
        `insert into service_categories (id, name, sort_order, updated_at) values ($1, $2, $3, now())`,
        [category.id, category.name, category.sortOrder],
      )
      return category
    }
    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.serviceCategories)) authState.serviceCategories = existing
    authState.serviceCategories.push(category)
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return category
  }

  /** Patch a category's name and/or sortOrder. Returns the updated category. */
  async updateServiceCategory(id, patch = {}) {
    if (!id) return null
    const nextName =
      typeof patch.name === 'string' ? patch.name.trim().slice(0, 80) : undefined
    const nextOrder =
      typeof patch.sortOrder === 'number' && Number.isFinite(patch.sortOrder)
        ? Math.max(0, Math.floor(patch.sortOrder))
        : undefined
    if (nextName === undefined && nextOrder === undefined) return null
    if (this.pool) {
      const result = await this.pool.query(
        `update service_categories
            set name = coalesce($2, name),
                sort_order = coalesce($3, sort_order),
                updated_at = now()
          where id = $1
        returning id, name, sort_order`,
        [id, nextName ?? null, nextOrder ?? null],
      )
      if (!result.rowCount) return null
      const row = result.rows[0]
      return { id: row.id, name: row.name, sortOrder: Number(row.sort_order) || 0 }
    }
    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.serviceCategories)) {
      authState.serviceCategories = await this.listServiceCategories()
    }
    const existing = authState.serviceCategories.find((c) => c.id === id)
    if (!existing) return null
    if (nextName !== undefined && nextName) existing.name = nextName
    if (nextOrder !== undefined) existing.sortOrder = nextOrder
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return { id: existing.id, name: existing.name, sortOrder: Number(existing.sortOrder) || 0 }
  }

  /**
   * Delete a category and clear it from any template/checklist that referenced
   * it (those fall back to the "Uncategorized" column). Returns true if a row
   * was removed.
   */
  async deleteServiceCategory(id) {
    if (!id) return false
    if (this.pool) {
      const result = await this.pool.query(`delete from service_categories where id = $1`, [id])
      await this.pool.query(
        `update checklist_templates set category_id = null where category_id = $1`,
        [id],
      )
      await this.pool.query(`update checklists set category_id = null where category_id = $1`, [id])
      return (result.rowCount ?? 0) > 0
    }
    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.serviceCategories)) {
      authState.serviceCategories = await this.listServiceCategories()
    }
    const before = authState.serviceCategories.length
    authState.serviceCategories = authState.serviceCategories.filter((c) => c.id !== id)
    const removed = authState.serviceCategories.length < before
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    if (removed) {
      // Clear dangling references in app-data so the board reads them as
      // Uncategorized rather than pointing at a missing column.
      const data = await readJson(localDataPath)
      let touched = false
      for (const list of [data.checklists, data.recycledChecklists, data.checklistTemplates]) {
        if (!Array.isArray(list)) continue
        for (const entry of list) {
          if (entry && entry.categoryId === id) {
            entry.categoryId = null
            touched = true
          }
        }
      }
      if (touched) await writeFile(localDataPath, JSON.stringify(data, null, 2))
    }
    return removed
  }

  async recordActivity(userId, action, target = '') {
    if (!userId || !action) {
      return
    }

    const id = `act-${randomUUID().slice(0, 8)}`
    const createdAt = nowIso()

    if (this.pool) {
      await this.pool.query(
        `insert into activity_log (id, user_id, action, target, created_at) values ($1, $2, $3, $4, $5)`,
        [id, userId, action, target, createdAt],
      )
      // Trim to last 200 entries per user.
      await this.pool.query(
        `
          delete from activity_log
          where user_id = $1
            and id not in (
              select id from activity_log
              where user_id = $1
              order by created_at desc
              limit 200
            )
        `,
        [userId],
      )
      return
    }

    const authState = await readJson(localAuthPath)
    const log = Array.isArray(authState.activityLog) ? authState.activityLog : []
    log.push({ id, userId, action, target, timestamp: createdAt })
    // Trim to last 200 per user.
    const counts = new Map()
    const trimmed = []
    for (let i = log.length - 1; i >= 0; i -= 1) {
      const entry = log[i]
      const next = (counts.get(entry.userId) ?? 0) + 1
      if (next <= 200) {
        trimmed.unshift(entry)
        counts.set(entry.userId, next)
      }
    }
    authState.activityLog = trimmed
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
  }

  async getRecentActivity(userId, limit = 20) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 20))

    if (this.pool) {
      const result = await this.pool.query(
        `
          select id, user_id, action, target, created_at
          from activity_log
          where user_id = $1
          order by created_at desc
          limit $2
        `,
        [userId, safeLimit],
      )
      return result.rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        action: row.action,
        target: row.target,
        timestamp: row.created_at ? new Date(row.created_at).toISOString() : nowIso(),
      }))
    }

    const authState = await readJson(localAuthPath)
    return (authState.activityLog ?? [])
      .filter((entry) => entry.userId === userId)
      .slice()
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
      .slice(0, safeLimit)
  }

  async getActivityRange(fromIso, toIso, limit = 2000) {
    const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 2000))
    const fromTs = fromIso || '1970-01-01T00:00:00.000Z'
    const toTs = toIso || nowIso()

    if (this.pool) {
      const result = await this.pool.query(
        `
          select id, user_id, action, target, created_at
          from activity_log
          where created_at >= $1 and created_at <= $2
          order by created_at desc
          limit $3
        `,
        [fromTs, toTs, safeLimit],
      )
      return result.rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        action: row.action,
        target: row.target,
        timestamp: row.created_at ? new Date(row.created_at).toISOString() : nowIso(),
      }))
    }

    const authState = await readJson(localAuthPath)
    return (authState.activityLog ?? [])
      .filter((entry) => entry.timestamp >= fromTs && entry.timestamp <= toTs)
      .slice()
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
      .slice(0, safeLimit)
  }

  async getGlobalActivity(limit = 15) {
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 15))

    if (this.pool) {
      const result = await this.pool.query(
        `
          select id, user_id, action, target, created_at
          from activity_log
          order by created_at desc
          limit $1
        `,
        [safeLimit],
      )
      return result.rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        action: row.action,
        target: row.target,
        timestamp: row.created_at ? new Date(row.created_at).toISOString() : nowIso(),
      }))
    }

    const authState = await readJson(localAuthPath)
    return (authState.activityLog ?? [])
      .slice()
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
      .slice(0, safeLimit)
  }

  // ---- Phase 3: template stage mutations ----

  async _readTemplateForStageUpdate(templateId) {
    if (this.pool) {
      const data = await this.read()
      const template = (data.checklistTemplates ?? []).find((t) => t.id === templateId) ?? null
      return { data, template, source: 'pg' }
    }
    const data = await readJson(localDataPath)
    if (Array.isArray(data.checklists)) {
      // ensure stage normalisation runs even before persistence
    }
    const templates = (data.checklistTemplates ?? []).map((t) => ensureTemplateStages(t))
    data.checklistTemplates = templates
    const template = templates.find((t) => t.id === templateId) ?? null
    return { data, template, source: 'file' }
  }

  async _persistTemplate(data, source) {
    if (source === 'pg') {
      await this.write(data)
    } else {
      await writeFile(localDataPath, JSON.stringify(data, null, 2))
    }
  }

  async addTemplateStage(templateId, stageInput) {
    const { data, template, source } = await this._readTemplateForStageUpdate(templateId)
    if (!template) return null
    const stages = Array.isArray(template.stages) ? template.stages : []
    const newStage = {
      id: `stage-${randomUUID().slice(0, 8)}`,
      name: typeof stageInput?.name === 'string' && stageInput.name.trim()
        ? stageInput.name.trim()
        : `Stage ${stages.length + 1}`,
      assigneeId: typeof stageInput?.assigneeId === 'string' && stageInput.assigneeId
        ? stageInput.assigneeId
        : template.assigneeId,
      offsetDays: Number.isFinite(Number(stageInput?.offsetDays)) ? Number(stageInput.offsetDays) : 0,
      viewerIds: Array.isArray(stageInput?.viewerIds) ? [...stageInput.viewerIds] : [],
      editorIds: Array.isArray(stageInput?.editorIds) ? [...stageInput.editorIds] : [],
      items: [],
    }
    const nextTemplates = (data.checklistTemplates ?? []).map((t) =>
      t.id === templateId ? { ...t, stages: [...stages, newStage] } : t,
    )
    const nextData = { ...data, checklistTemplates: nextTemplates }
    await this._persistTemplate(nextData, source)
    return { template: nextTemplates.find((t) => t.id === templateId), stage: newStage }
  }

  async removeTemplateStage(templateId, stageId) {
    const { data, template, source } = await this._readTemplateForStageUpdate(templateId)
    if (!template) return null
    const stages = Array.isArray(template.stages) ? template.stages : []
    const filtered = stages.filter((stage) => stage.id !== stageId)
    if (filtered.length === stages.length) return null
    const nextTemplates = (data.checklistTemplates ?? []).map((t) =>
      t.id === templateId ? { ...t, stages: filtered } : t,
    )
    const nextData = { ...data, checklistTemplates: nextTemplates }
    await this._persistTemplate(nextData, source)
    return nextTemplates.find((t) => t.id === templateId)
  }

  async patchTemplateStage(templateId, stageId, patch) {
    const { data, template, source } = await this._readTemplateForStageUpdate(templateId)
    if (!template) return null
    const stages = Array.isArray(template.stages) ? template.stages : []
    let mutated = false
    const nextStages = stages.map((stage) => {
      if (stage.id !== stageId) return stage
      mutated = true
      const next = { ...stage }
      if (typeof patch?.name === 'string' && patch.name.trim()) next.name = patch.name.trim()
      if (typeof patch?.assigneeId === 'string' && patch.assigneeId) next.assigneeId = patch.assigneeId
      if (Number.isFinite(Number(patch?.offsetDays))) next.offsetDays = Number(patch.offsetDays)
      // Per-stage explicit due date. An empty string / null clears it (falls
      // back to the offsetDays calculation); a yyyy-mm-dd string sets it.
      if (patch && Object.prototype.hasOwnProperty.call(patch, 'dueDate')) {
        if (typeof patch.dueDate === 'string' && patch.dueDate.trim()) {
          next.dueDate = patch.dueDate.trim()
        } else {
          delete next.dueDate
        }
      }
      if (Array.isArray(patch?.viewerIds)) {
        next.viewerIds = [...new Set(patch.viewerIds.filter((id) => typeof id === 'string'))]
      }
      if (Array.isArray(patch?.editorIds)) {
        next.editorIds = [...new Set(
          patch.editorIds.filter((id) => typeof id === 'string' && next.viewerIds.includes(id)),
        )]
      }
      return next
    })
    if (!mutated) return null
    const nextTemplates = (data.checklistTemplates ?? []).map((t) =>
      t.id === templateId ? { ...t, stages: nextStages } : t,
    )
    const nextData = { ...data, checklistTemplates: nextTemplates }
    await this._persistTemplate(nextData, source)
    return nextTemplates.find((t) => t.id === templateId)
  }

  async reorderTemplateStages(templateId, orderedStageIds) {
    const { data, template, source } = await this._readTemplateForStageUpdate(templateId)
    if (!template) return null
    const stages = Array.isArray(template.stages) ? template.stages : []
    const byId = new Map(stages.map((stage) => [stage.id, stage]))
    const reordered = orderedStageIds
      .map((id) => byId.get(id))
      .filter((stage) => Boolean(stage))
    const seen = new Set(orderedStageIds)
    const tail = stages.filter((stage) => !seen.has(stage.id))
    const nextStages = [...reordered, ...tail]
    const nextTemplates = (data.checklistTemplates ?? []).map((t) =>
      t.id === templateId ? { ...t, stages: nextStages } : t,
    )
    const nextData = { ...data, checklistTemplates: nextTemplates }
    await this._persistTemplate(nextData, source)
    return nextTemplates.find((t) => t.id === templateId)
  }

  // ---- Wave 2: standard templates + apply/copy + on-demand materialization ----

  /**
   * Create a standard (client-agnostic) template. A standard template is a
   * reusable blueprint: it has no client, is_standard = true, and never
   * materializes checklists on its own. Owner-only — caller enforces auth.
   */
  async createStandardTemplate(input) {
    const data = await this.read()
    const stagesInput = Array.isArray(input?.stages) ? input.stages : []
    const stages = stagesInput.map((stage, index) => ({
      id: `stage-${randomUUID().slice(0, 8)}`,
      name: typeof stage?.name === 'string' && stage.name.trim() ? stage.name.trim() : `Stage ${index + 1}`,
      assigneeId: typeof stage?.assigneeId === 'string' ? stage.assigneeId : '',
      offsetDays: Number.isFinite(Number(stage?.offsetDays)) ? Number(stage.offsetDays) : 0,
      ...(typeof stage?.dueDate === 'string' && stage.dueDate.trim()
        ? { dueDate: stage.dueDate.trim() }
        : {}),
      viewerIds: Array.isArray(stage?.viewerIds) ? [...stage.viewerIds] : [],
      editorIds: Array.isArray(stage?.editorIds) ? [...stage.editorIds] : [],
      items: Array.isArray(stage?.items)
        ? stage.items
            .filter((item) => typeof item?.label === 'string' && item.label.trim())
            .map((item) => ({
              id: `template-item-${randomUUID().slice(0, 8)}`,
              label: item.label.trim(),
              ...(item.dueDate ? { dueDate: item.dueDate } : {}),
              ...(item.assigneeId ? { assigneeId: item.assigneeId } : {}),
            }))
        : [],
    }))

    const template = {
      id: `template-${randomUUID().slice(0, 8)}`,
      title: typeof input?.title === 'string' && input.title.trim() ? input.title.trim() : 'Standard template',
      clientId: '',
      assigneeId: typeof input?.assigneeId === 'string' ? input.assigneeId : '',
      frequency: typeof input?.frequency === 'string' ? input.frequency : 'monthly',
      nextDueDate: typeof input?.nextDueDate === 'string' && input.nextDueDate
        ? input.nextDueDate
        : formatDateOnly(new Date()),
      active: false,
      isStandard: true,
      viewerIds: [],
      editorIds: [],
      stages: stages.length > 0
        ? stages
        : [
            {
              id: `stage-${randomUUID().slice(0, 8)}`,
              name: 'Stage 1',
              assigneeId: typeof input?.assigneeId === 'string' ? input.assigneeId : '',
              offsetDays: 0,
              viewerIds: [],
              editorIds: [],
              items: [],
            },
          ],
    }

    const nextData = {
      ...data,
      checklistTemplates: [...(data.checklistTemplates ?? []), template],
    }
    await this.write(nextData)
    return template
  }

  /**
   * Copy a source template (standard OR regular) onto a client, producing a
   * NEW regular client-bound template. Fresh ids are generated for the new
   * template and every stage/item. The copy's isStandard is always false.
   * Owner-only — caller enforces auth.
   */
  async copyTemplateToClient(sourceTemplateId, { clientId, firstDueDate, frequency } = {}) {
    // A recurring recipe on a master would spawn tasks on a client that collects
    // nothing — the same refusal the one-off checklist path makes.
    await this._refuseBillingMasterWrite(clientId, 'recurring task recipes')
    const data = await this.read()
    const source = (data.checklistTemplates ?? []).find((t) => t.id === sourceTemplateId)
    if (!source) return null

    const migrated = ensureTemplateStages(source)
    const copy = {
      id: `template-${randomUUID().slice(0, 8)}`,
      title: source.title,
      clientId,
      assigneeId: source.assigneeId || '',
      frequency: typeof frequency === 'string' && frequency ? frequency : source.frequency,
      nextDueDate: typeof firstDueDate === 'string' && firstDueDate
        ? firstDueDate
        : source.nextDueDate || formatDateOnly(new Date()),
      active: true,
      isStandard: false,
      viewerIds: Array.isArray(source.viewerIds) ? [...source.viewerIds] : [],
      editorIds: Array.isArray(source.editorIds) ? [...source.editorIds] : [],
      stages: (migrated.stages ?? []).map((stage) => ({
        id: `stage-${randomUUID().slice(0, 8)}`,
        name: stage.name,
        assigneeId: stage.assigneeId || source.assigneeId || '',
        offsetDays: Number(stage.offsetDays) || 0,
        ...(stage.dueDate ? { dueDate: stage.dueDate } : {}),
        viewerIds: Array.isArray(stage.viewerIds) ? [...stage.viewerIds] : [],
        editorIds: Array.isArray(stage.editorIds) ? [...stage.editorIds] : [],
        items: (stage.items ?? []).map((item) => ({
          id: `template-item-${randomUUID().slice(0, 8)}`,
          label: item.label,
          ...(item.dueDate ? { dueDate: item.dueDate } : {}),
          ...(item.assigneeId ? { assigneeId: item.assigneeId } : {}),
        })),
      })),
    }

    const nextData = {
      ...data,
      checklistTemplates: [...(data.checklistTemplates ?? []), copy],
    }
    await this.write(nextData)
    return copy
  }

  /**
   * Materialize a Stage-1 checklist instance from a template on demand —
   * powers "Generate a task now" and the "Start the first one now" option.
   * `dueDate` defaults to the template's nextDueDate. Returns the created
   * checklist, or null if the template has no items in stage 1.
   * Owner-only — caller enforces auth.
   */
  async generateChecklistFromTemplate(templateId, { dueDate } = {}) {
    const data = await this.read()
    const rawTemplate = (data.checklistTemplates ?? []).find((t) => t.id === templateId)
    if (!rawTemplate) return null
    const template = ensureTemplateStages(rawTemplate)
    const stages = template.stages ?? []
    // Generate even when Stage 1 has no items. "Get ahead" from the timer just
    // needs a real checklist to log time against, and plenty of recurring tasks
    // (e.g. a plain "Monthly Bookkeeping") have no sub-steps — refusing those
    // was why an upcoming recurring task couldn't be started. An empty checklist
    // is valid; items can be added afterward. (ensureTemplateStages always
    // yields at least one stage, so this guard is essentially defensive.)
    if (stages.length === 0) return null
    const stageOne = stages[0]
    const baseDate = typeof dueDate === 'string' && dueDate
      ? dueDate
      : template.nextDueDate || formatDateOnly(new Date())
    const stageOneDue = resolveStageDueDate(stageOne, baseDate)

    // "Generate a task now" is idempotent: if this template already has a
    // Stage-1 instance on that due date, hand back the one that exists instead
    // of minting a second. Two people clicking "start the first one now" (or one
    // person double-clicking) used to produce two identical checklists; now it
    // also can't violate the UNIQUE partial index and 500 the request.
    const existing = findChecklistInstance(data.checklists, template.id, stageOneDue, 0)
    if (existing) return existing

    const caseId = `case-${randomUUID().slice(0, 8)}`
    const checklist = buildChecklistFromStage({
      template,
      stage: stageOne,
      stageIndex: 0,
      stageCount: stages.length,
      caseId,
      dueDate: stageOneDue,
    })
    const created = await this.createChecklist(checklist)
    await this.grantClientVisibility(created.clientId, created.assigneeId)
    return created
  }

  /**
   * Returns { template, client, stages: [{ stage, checklist }], activity }
   * for the case identified by caseId. Owner-only — caller enforces auth.
   */
  async getCase(caseId) {
    const data = await this.read()
    const checklistsForCase = (data.checklists ?? []).filter((c) => c.caseId === caseId)
    if (checklistsForCase.length === 0) return null
    const templateId = checklistsForCase[0].templateId
    const template = (data.checklistTemplates ?? []).find((t) => t.id === templateId) ?? null
    if (!template) return null
    const client = (data.clients ?? []).find((c) => c.id === template.clientId) ?? null
    const stages = (template.stages ?? []).map((stage, index) => {
      const checklist = checklistsForCase.find(
        (c) => c.stageId === stage.id || c.stageIndex === index,
      ) ?? null
      return { stage, checklist }
    })

    // Pull case-tagged activity entries.
    let activity = []
    if (this.pool) {
      const result = await this.pool.query(
        `
          select id, user_id, action, target, created_at
          from activity_log
          where target like $1
          order by created_at desc
          limit 100
        `,
        [`%${caseId}%`],
      )
      activity = result.rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        action: row.action,
        target: row.target,
        timestamp: row.created_at ? new Date(row.created_at).toISOString() : nowIso(),
      }))
    } else {
      const authState = await readJson(localAuthPath)
      activity = (authState.activityLog ?? [])
        .filter((entry) => typeof entry.target === 'string' && entry.target.includes(caseId))
        .slice()
        .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
        .slice(0, 100)
    }

    return { template, client, stages, activity, caseId }
  }

  // ---- Phase 5: notifications ----

  async createNotification(userId, event, message, link, payload) {
    if (!userId || !event) {
      return null
    }
    const id = `notif-${randomUUID().slice(0, 8)}`
    const createdAt = nowIso()
    const safeMessage = String(message ?? '')
    const safeLink = link ? String(link) : null
    const safePayload = payload && typeof payload === 'object' ? payload : {}

    if (this.pool) {
      await this.pool.query(
        `insert into notifications (id, user_id, event, message, link, payload, created_at)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [id, userId, event, safeMessage, safeLink, JSON.stringify(safePayload), createdAt],
      )
      return {
        id,
        userId,
        event,
        message: safeMessage,
        link: safeLink,
        payload: safePayload,
        readAt: null,
        createdAt,
      }
    }

    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.notifications)) {
      authState.notifications = []
    }
    const entry = {
      id,
      userId,
      event,
      message: safeMessage,
      link: safeLink,
      payload: safePayload,
      readAt: null,
      createdAt,
    }
    authState.notifications.push(entry)
    // Trim per-user to last 100 (oldest dropped).
    const counts = new Map()
    const trimmed = []
    for (let i = authState.notifications.length - 1; i >= 0; i -= 1) {
      const item = authState.notifications[i]
      const next = (counts.get(item.userId) ?? 0) + 1
      if (next <= 100) {
        trimmed.unshift(item)
        counts.set(item.userId, next)
      }
    }
    authState.notifications = trimmed
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return entry
  }

  async listNotifications(userId, { limit = 50, unreadOnly = false } = {}) {
    if (!userId) return []
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50))

    if (this.pool) {
      const params = [userId]
      let where = `where user_id = $1`
      if (unreadOnly) {
        where += ` and read_at is null`
      }
      params.push(safeLimit)
      const result = await this.pool.query(
        `select id, user_id, event, message, link, payload, read_at, created_at
         from notifications
         ${where}
         order by created_at desc
         limit $${params.length}`,
        params,
      )
      return result.rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        event: row.event,
        message: row.message,
        link: row.link,
        payload: row.payload ?? {},
        readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : nowIso(),
      }))
    }

    const authState = await readJson(localAuthPath)
    return (authState.notifications ?? [])
      .filter((entry) => entry.userId === userId)
      .filter((entry) => (unreadOnly ? !entry.readAt : true))
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, safeLimit)
  }

  async markNotificationRead(notificationId, userId) {
    if (!notificationId || !userId) return null
    const readAt = nowIso()

    if (this.pool) {
      const result = await this.pool.query(
        `update notifications
         set read_at = coalesce(read_at, $3)
         where id = $1 and user_id = $2
         returning id, user_id, event, message, link, payload, read_at, created_at`,
        [notificationId, userId, readAt],
      )
      if (!result.rowCount) return null
      const row = result.rows[0]
      return {
        id: row.id,
        userId: row.user_id,
        event: row.event,
        message: row.message,
        link: row.link,
        payload: row.payload ?? {},
        readAt: row.read_at ? new Date(row.read_at).toISOString() : readAt,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : nowIso(),
      }
    }

    const authState = await readJson(localAuthPath)
    let found = null
    authState.notifications = (authState.notifications ?? []).map((entry) => {
      if (entry.id !== notificationId || entry.userId !== userId) return entry
      const next = { ...entry, readAt: entry.readAt ?? readAt }
      found = next
      return next
    })
    if (!found) return null
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return found
  }

  async markAllNotificationsRead(userId) {
    if (!userId) return 0
    const readAt = nowIso()

    if (this.pool) {
      const result = await this.pool.query(
        `update notifications set read_at = $2 where user_id = $1 and read_at is null`,
        [userId, readAt],
      )
      return result.rowCount ?? 0
    }

    const authState = await readJson(localAuthPath)
    let count = 0
    authState.notifications = (authState.notifications ?? []).map((entry) => {
      if (entry.userId !== userId || entry.readAt) return entry
      count += 1
      return { ...entry, readAt }
    })
    if (count > 0) {
      await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    }
    return count
  }

  async unreadNotificationCount(userId) {
    if (!userId) return 0
    if (this.pool) {
      const result = await this.pool.query(
        `select count(*)::int as count from notifications where user_id = $1 and read_at is null`,
        [userId],
      )
      return result.rows[0]?.count ?? 0
    }
    const authState = await readJson(localAuthPath)
    return (authState.notifications ?? []).filter(
      (entry) => entry.userId === userId && !entry.readAt,
    ).length
  }

  async getFirmSettings() {
    if (this.pool) {
      const result = await this.pool.query(
        `select name, tagline, logo_url, brand_color, sidebar_text_color,
                sidebar_active_text_color,
                address_line1, address_line2,
                city, state, postal_code, phone, email, website, ein,
                client_defaults
           from firm_settings where id = 'singleton'`,
      )
      return rowToFirmSettings(result.rows[0])
    }
    const data = await readJson(localDataPath)
    const stored = data.firmSettings || {}
    return {
      ...DEFAULT_FIRM_SETTINGS,
      ...stored,
      clientDefaults: {
        ...DEFAULT_FIRM_SETTINGS.clientDefaults,
        ...sanitizeClientDefaults(stored.clientDefaults),
      },
    }
  }

  async updateFirmSettings(patch) {
    const current = await this.getFirmSettings()
    const next = { ...current }
    // Color fields are bound straight into inline styles client-side, so a
    // malformed value would be a CSS-injection vector. Accept only 6-digit
    // hex; anything else is ignored (the prior/default value is kept).
    const HEX_COLOR_FIELDS = new Set(['brandColor', 'sidebarTextColor', 'sidebarActiveTextColor'])
    const isHexColor = (value) => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
    for (const [appKey] of FIRM_SETTINGS_FIELDS) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, appKey)) {
        const value = patch[appKey]
        if (HEX_COLOR_FIELDS.has(appKey)) {
          if (isHexColor(value)) {
            next[appKey] = value
          }
          // Invalid color: leave the existing/default value untouched.
        } else if (typeof value === 'string') {
          next[appKey] = value
        } else if (value === null || value === undefined) {
          next[appKey] = appKey === 'name' ? DEFAULT_FIRM_SETTINGS.name : ''
        }
      }
    }
    if (!next.name || !next.name.trim()) {
      next.name = DEFAULT_FIRM_SETTINGS.name
    }

    // New-client defaults: merge the validated patch over the current values
    // so a partial update (just the hourly rate, say) doesn't wipe the rest.
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'clientDefaults')) {
      next.clientDefaults = {
        ...(next.clientDefaults ?? DEFAULT_FIRM_SETTINGS.clientDefaults),
        ...sanitizeClientDefaults(patch.clientDefaults),
      }
    }

    if (this.pool) {
      await this.pool.query(
        `insert into firm_settings (id, name, tagline, logo_url, brand_color, sidebar_text_color,
            sidebar_active_text_color,
            address_line1, address_line2, city, state, postal_code,
            phone, email, website, ein, client_defaults, updated_at)
         values ('singleton', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, now())
         on conflict (id) do update set
            name = excluded.name,
            tagline = excluded.tagline,
            logo_url = excluded.logo_url,
            brand_color = excluded.brand_color,
            sidebar_text_color = excluded.sidebar_text_color,
            sidebar_active_text_color = excluded.sidebar_active_text_color,
            address_line1 = excluded.address_line1,
            address_line2 = excluded.address_line2,
            city = excluded.city,
            state = excluded.state,
            postal_code = excluded.postal_code,
            phone = excluded.phone,
            email = excluded.email,
            website = excluded.website,
            ein = excluded.ein,
            client_defaults = excluded.client_defaults,
            updated_at = now()`,
        [
          next.name,
          next.tagline || null,
          next.logoUrl || null,
          next.brandColor || null,
          next.sidebarTextColor || null,
          next.sidebarActiveTextColor || null,
          next.addressLine1 || null,
          next.addressLine2 || null,
          next.city || null,
          next.state || null,
          next.postalCode || null,
          next.phone || null,
          next.email || null,
          next.website || null,
          next.ein || null,
          JSON.stringify(next.clientDefaults ?? DEFAULT_FIRM_SETTINGS.clientDefaults),
        ],
      )
      return next
    }

    const data = await readJson(localDataPath)
    data.firmSettings = next
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return next
  }

  // ---- Email-gated authentication ----

  /**
   * Look up a user record by email (case-insensitive). Returns the
   * full row shape used by createLoginToken / createUserSession; null if
   * no match.
   */
  async findUserByEmail(email) {
    const trimmed = String(email ?? '').trim().toLowerCase()
    if (!trimmed) return null

    if (this.pool) {
      // Skip soft-deleted users — they shouldn't be able to sign in via
      // password OR receive a magic link. From the caller's perspective
      // an inactive user is indistinguishable from a missing one.
      const result = await this.pool.query(
        `select id, name, email, role, staff_role, password_hash
         from users
         where lower(email) = $1 and inactive_at is null`,
        [trimmed],
      )
      if (!result.rowCount) return null
      const row = result.rows[0]
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
        staffRole: row.staff_role,
        // Carry the hash for password sign-in / change flows. Server-only —
        // never leaks to the client; the only callers (signInWithPassword,
        // applyOwnerBootstrapPassword) verify it then discard.
        passwordHash: row.password_hash,
      }
    }

    const authState = await readJson(localAuthPath)
    const user = (authState.users ?? []).find(
      (entry) =>
        entry.email &&
        entry.email.toLowerCase() === trimmed &&
        !entry.inactiveAt,
    )
    if (!user) return null
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      staffRole: user.staffRole,
      passwordHash: user.passwordHash,
    }
  }

  /**
   * Create a single-use 15-minute sign-in link token for the given user.
   * Returns { token, expiresAt }.
   */
  async createLoginToken(userId, ipAddress = null) {
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + 1000 * 60 * 15)
    const createdAt = nowIso()

    if (this.pool) {
      await this.pool.query(
        `insert into login_tokens (token, user_id, expires_at, ip_address, created_at)
         values ($1, $2, $3, $4, $5)`,
        [token, userId, expiresAt.toISOString(), ipAddress || null, createdAt],
      )
      return { token, expiresAt }
    }

    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.loginTokens)) authState.loginTokens = []
    authState.loginTokens.push({
      token,
      userId,
      expiresAt: expiresAt.toISOString(),
      consumedAt: null,
      ipAddress: ipAddress || null,
      createdAt,
    })
    // Trim: keep only un-expired or recently-consumed (last 200) tokens.
    const cutoff = Date.now() - 1000 * 60 * 60 * 24
    authState.loginTokens = authState.loginTokens
      .filter((entry) => {
        const exp = new Date(entry.expiresAt).getTime()
        const consumed = entry.consumedAt ? new Date(entry.consumedAt).getTime() : 0
        return exp > Date.now() || consumed > cutoff
      })
      .slice(-500)
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return { token, expiresAt }
  }

  /**
   * Validate a sign-in link token. Returns { userId } when the token exists
   * and has not yet expired (15-minute window from creation), null otherwise.
   *
   * Reusable within the expiry window — the link no longer self-destructs
   * on first use. Rationale:
   *  1. Email-security scanners (Gmail / Outlook / corporate firewalls)
   *     routinely pre-fetch URLs in incoming mail to scan them, which
   *     would burn a single-use token before the human ever clicks it.
   *     Reusable tokens are the standard fix.
   *  2. A second click (browser link-preview, accidental double-tap,
   *     refresh of the verify page) shouldn't lock the user out.
   *  3. TOTP is the real session gate — owners are forced into setup,
   *     and any 2FA-enabled user has to clear the challenge before a
   *     full session is issued. The link just gets you to the gate.
   *
   * We still stamp `consumed_at` on first use as telemetry (when was the
   * link first followed) but don't reject subsequent uses. The row drops
   * naturally past `expires_at`.
   */
  async consumeLoginToken(token) {
    if (!token) return null
    const consumedAt = nowIso()

    if (this.pool) {
      const result = await this.pool.query(
        `update login_tokens
         set consumed_at = coalesce(consumed_at, $2)
         where token = $1
           and expires_at > now()
           and exists (
             select 1 from users
             where users.id = login_tokens.user_id
               and users.inactive_at is null
           )
         returning user_id`,
        [token, consumedAt],
      )
      if (!result.rowCount) return null
      return { userId: result.rows[0].user_id }
    }

    const authState = await readJson(localAuthPath)
    let resolved = null
    authState.loginTokens = (authState.loginTokens ?? []).map((entry) => {
      if (entry.token !== token) return entry
      if (new Date(entry.expiresAt).getTime() <= Date.now()) return entry
      // Reject if the user has been soft-deleted since the token was issued.
      const user = (authState.users ?? []).find((u) => u.id === entry.userId)
      if (!user || user.inactiveAt) return entry
      resolved = { userId: entry.userId }
      // First-use telemetry only — don't gate on it.
      return entry.consumedAt ? entry : { ...entry, consumedAt }
    })
    if (!resolved) return null
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return resolved
  }

  /**
   * Update a single user's password_hash from a new plain-text password.
   * Authorization is the caller's responsibility — usually "session cookie
   * belongs to userId" via the change-password endpoint.
   *
   * SECURITY (M4): once a user has set their OWN password (password_set_at is
   * non-null) we require the current password before changing it, so a
   * hijacked session can't silently rotate the credential and lock the real
   * user out. A first-time set (password_set_at null — still on the seed or
   * the M2 random default) is allowed with just the session, since the user
   * can't know that default. The gate verdict comes from the pure
   * `evaluatePasswordChange` helper; this method supplies the facts (and the
   * timing-safe `verifyPassword`) and, on success, stamps password_set_at.
   *
   * Returns a discriminated result so the endpoint can map it to a status:
   *   { ok: true }
   *   { ok: false, status, error }   // gate failed (missing/wrong current pw)
   *   { ok: false, status: 404 }     // no such user / row didn't match
   *
   * @param {string} userId
   * @param {string} newPassword
   * @param {string} [currentPassword]  Required once password_set_at is set.
   */
  async setUserPassword(userId, newPassword, currentPassword = '') {
    if (!userId || typeof newPassword !== 'string' || !newPassword) {
      return { ok: false, status: 400, error: 'A new password is required.' }
    }
    const suppliedCurrent = typeof currentPassword === 'string' ? currentPassword : ''
    const newHash = hashPassword(newPassword)

    if (this.pool) {
      const existing = await this.pool.query(
        `select password_hash, password_set_at from users where id = $1`,
        [userId],
      )
      if (!existing.rowCount) return { ok: false, status: 404, error: 'User not found.' }
      const row = existing.rows[0]
      const gate = evaluatePasswordChange({
        passwordSetAt: row.password_set_at,
        currentPasswordProvided: suppliedCurrent.length > 0,
        currentPasswordValid:
          suppliedCurrent.length > 0 &&
          Boolean(row.password_hash) &&
          verifyPassword(suppliedCurrent, row.password_hash),
      })
      if (!gate.allowed) return { ok: false, status: gate.status, error: gate.error }

      const result = await this.pool.query(
        `update users set password_hash = $1, password_set_at = now(), updated_at = now() where id = $2`,
        [newHash, userId],
      )
      if ((result.rowCount ?? 0) === 0) return { ok: false, status: 404, error: 'User not found.' }
      return { ok: true }
    }

    const authState = await readJson(localAuthPath)
    const target = (authState.users ?? []).find((user) => user.id === userId)
    if (!target) return { ok: false, status: 404, error: 'User not found.' }
    const gate = evaluatePasswordChange({
      passwordSetAt: target.passwordSetAt,
      currentPasswordProvided: suppliedCurrent.length > 0,
      currentPasswordValid:
        suppliedCurrent.length > 0 &&
        Boolean(target.passwordHash) &&
        verifyPassword(suppliedCurrent, target.passwordHash),
    })
    if (!gate.allowed) return { ok: false, status: gate.status, error: gate.error }

    target.passwordHash = newHash
    target.passwordSetAt = nowIso()
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return { ok: true }
  }

  /**
   * Email + password sign-in. Looks up by lowercase email, verifies via the
   * existing scrypt `verifyPassword`, then issues a full session via the
   * same `createUserSession` path the magic-link verify uses. Returns the
   * session record on success; null when the user doesn't exist OR the
   * password doesn't match — the caller can't tell the two apart so a
   * common 401 is safe. The TOTP / forced-setup branching is handled by
   * the server-side endpoint (mirrors the magic-link verify flow).
   */
  async signInWithPassword(email, password, userAgent = null, ipAddress = null) {
    if (typeof email !== 'string' || !email.trim()) return null
    if (typeof password !== 'string' || !password) return null
    const user = await this.findUserByEmail(email)
    if (!user) return null
    // findUserByEmail returns camelCase in file mode and snake_case from
    // the raw row in Postgres mode — accept either so this works in both.
    const storedHash = user.passwordHash ?? user.password_hash
    if (!storedHash || !verifyPassword(password, storedHash)) return null
    return await this.createUserSession(user.id, userAgent, ipAddress)
  }

  /**
   * Boot-time owner password bootstrap — fresh-install recovery only.
   *
   * Applies `OWNER_BOOTSTRAP_PASSWORD` to the first owner's `password_hash`
   * ONLY when the current password is the seed demo default (`pbj-demo`,
   * or whatever AUTH_DEMO_PASSWORD overrides it to). Once any real
   * password has been set — whether via the env var on a previous boot,
   * the in-app "Set password" card, or anything else — this function is a
   * no-op. That prevents a redeploy from clobbering a password the user
   * has just changed inside the app (the bug that locked us out before).
   *
   * If you want to FORCE a reset (e.g. the owner forgot their password),
   * keep the env var set and clear the row's password via a DB-side reset
   * back to the demo hash; the next boot will then re-apply the env var.
   * Day-to-day, set the env var, deploy once, sign in, change in-app, done.
   */
  async applyOwnerBootstrapPassword() {
    const password = process.env.OWNER_BOOTSTRAP_PASSWORD
    if (typeof password !== 'string' || password.length === 0) return false

    if (this.pool) {
      const result = await this.pool.query(
        `select id, password_hash from users
         where role = 'owner'
         order by created_at asc, name asc
         limit 1`,
      )
      if (!result.rowCount) {
        console.log('[bootstrap] OWNER_BOOTSTRAP_PASSWORD is set but no owner user exists')
        return false
      }
      const owner = result.rows[0]
      if (!owner.password_hash) {
        // No hash at all — apply the env value (fresh install edge case).
        await this.pool.query(
          `update users set password_hash = $1, updated_at = now() where id = $2`,
          [hashPassword(password), owner.id],
        )
        console.log(`[bootstrap] owner password set for user id ${owner.id} (no prior hash)`)
        return true
      }
      if (verifyPassword(password, owner.password_hash)) {
        // Already the env value — silent no-op.
        return false
      }
      if (!verifyPassword(demoPassword, owner.password_hash)) {
        // Real, user-chosen password is already in place. Leave it alone.
        console.log(
          '[bootstrap] owner already has a non-default password; OWNER_BOOTSTRAP_PASSWORD ignored',
        )
        return false
      }
      // Demo seed password is still in place — this is the fresh-install
      // / first-deploy case the bootstrap exists for.
      await this.pool.query(
        `update users set password_hash = $1, updated_at = now() where id = $2`,
        [hashPassword(password), owner.id],
      )
      console.log(`[bootstrap] owner password seeded from env for user id ${owner.id}`)
      return true
    }

    const authState = await readJson(localAuthPath)
    const owner = (authState.users ?? []).find((user) => user.role === 'owner')
    if (!owner) {
      console.log('[bootstrap] OWNER_BOOTSTRAP_PASSWORD is set but no owner user exists')
      return false
    }
    if (!owner.passwordHash) {
      owner.passwordHash = hashPassword(password)
      await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
      console.log(`[bootstrap] owner password set for user id ${owner.id} (file mode, no prior)`)
      return true
    }
    if (verifyPassword(password, owner.passwordHash)) {
      return false
    }
    if (!verifyPassword(demoPassword, owner.passwordHash)) {
      console.log(
        '[bootstrap] owner already has a non-default password; OWNER_BOOTSTRAP_PASSWORD ignored (file mode)',
      )
      return false
    }
    owner.passwordHash = hashPassword(password)
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    console.log(`[bootstrap] owner password seeded from env for user id ${owner.id} (file mode)`)
    return true
  }

  /**
   * Create a persistent user session. Returns { sessionId, user, lastSeenAt }.
   * Used by /verify/:token after a successful link consumption.
   */
  async createUserSession(userId, userAgent = null, ipAddress = null) {
    const sessionId = randomUUID()
    const createdAt = nowIso()
    const safeUa = userAgent ? String(userAgent).slice(0, 200) : null
    const safeIp = ipAddress ? String(ipAddress).slice(0, 80) : null

    if (this.pool) {
      await this.pool.query(
        `insert into user_sessions (id, user_id, created_at, last_seen_at, user_agent, ip_address)
         values ($1, $2, $3, $3, $4, $5)`,
        [sessionId, userId, createdAt, safeUa, safeIp],
      )
      await this.pool.query(`update users set last_active_at = now() where id = $1`, [userId])
      const result = await this.pool.query(
        `select id, name, email, role, staff_role from users where id = $1`,
        [userId],
      )
      if (!result.rowCount) return null
      const row = result.rows[0]
      return {
        sessionId,
        lastSeenAt: createdAt,
        user: mapSessionUser({
          id: row.id,
          name: row.name,
          email: row.email,
          role: row.role,
          staffRole: row.staff_role,
        }),
      }
    }

    const authState = await readJson(localAuthPath)
    const user = (authState.users ?? []).find((entry) => entry.id === userId)
    if (!user) return null
    user.lastActiveAt = createdAt
    if (!Array.isArray(authState.userSessions)) authState.userSessions = []
    authState.userSessions.push({
      id: sessionId,
      userId,
      createdAt,
      lastSeenAt: createdAt,
      revokedAt: null,
      userAgent: safeUa,
      ipAddress: safeIp,
    })
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return {
      sessionId,
      lastSeenAt: createdAt,
      user: mapSessionUser(user),
    }
  }

  /**
   * Look up a session by id. Touches `lastSeenAt` to slide the 30-day expiry.
   * Returns { sessionId, user, lastSeenAt } or null if unknown / revoked.
   */
  async getUserSession(sessionId) {
    if (!sessionId) return null
    const lastSeenAt = nowIso()

    if (this.pool) {
      const result = await this.pool.query(
        `select s.id, s.user_id, s.last_seen_at, s.revoked_at,
                u.name, u.email, u.role, u.staff_role
         from user_sessions s
         join users u on u.id = s.user_id
         where s.id = $1
           and u.inactive_at is null`,
        [sessionId],
      )
      if (!result.rowCount) return null
      const row = result.rows[0]
      if (row.revoked_at) return null
      await this.pool.query(
        `update user_sessions set last_seen_at = $2 where id = $1`,
        [sessionId, lastSeenAt],
      )
      return {
        sessionId,
        lastSeenAt,
        user: mapSessionUser({
          id: row.user_id,
          name: row.name,
          email: row.email,
          role: row.role,
          staffRole: row.staff_role,
        }),
      }
    }

    const authState = await readJson(localAuthPath)
    const list = Array.isArray(authState.userSessions) ? authState.userSessions : []
    const entry = list.find((item) => item.id === sessionId)
    if (!entry || entry.revokedAt) return null
    const user = (authState.users ?? []).find((item) => item.id === entry.userId)
    // A removed (inactive) user's open session must stop working immediately —
    // mirrors the `u.inactive_at is null` guard on the Postgres path.
    if (!user || user.inactiveAt) return null
    entry.lastSeenAt = lastSeenAt
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return {
      sessionId,
      lastSeenAt,
      user: mapSessionUser(user),
    }
  }

  async revokeUserSession(sessionId) {
    if (!sessionId) return null
    const revokedAt = nowIso()

    if (this.pool) {
      const result = await this.pool.query(
        `update user_sessions set revoked_at = $2 where id = $1 and revoked_at is null
         returning id, user_id, user_agent, ip_address, last_seen_at`,
        [sessionId, revokedAt],
      )
      if (!result.rowCount) return null
      const row = result.rows[0]
      return {
        id: row.id,
        userId: row.user_id,
        userAgent: row.user_agent,
        ipAddress: row.ip_address,
        lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
      }
    }

    const authState = await readJson(localAuthPath)
    let revoked = null
    authState.userSessions = (authState.userSessions ?? []).map((entry) => {
      if (entry.id !== sessionId || entry.revokedAt) return entry
      revoked = { ...entry, revokedAt }
      return revoked
    })
    if (!revoked) return null
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return {
      id: revoked.id,
      userId: revoked.userId,
      userAgent: revoked.userAgent,
      ipAddress: revoked.ipAddress,
      lastSeenAt: revoked.lastSeenAt,
    }
  }

  /**
   * Revoke every active session for the user. If `exceptSessionId` is
   * provided, that session is left intact. Returns the number revoked.
   */
  async revokeAllUserSessions(userId, exceptSessionId = null) {
    if (!userId) return 0
    const revokedAt = nowIso()

    if (this.pool) {
      const params = [userId, revokedAt]
      let where = `user_id = $1 and revoked_at is null`
      if (exceptSessionId) {
        params.push(exceptSessionId)
        where += ` and id <> $${params.length}`
      }
      const result = await this.pool.query(
        `update user_sessions set revoked_at = $2 where ${where}`,
        params,
      )
      return result.rowCount ?? 0
    }

    const authState = await readJson(localAuthPath)
    let count = 0
    authState.userSessions = (authState.userSessions ?? []).map((entry) => {
      if (entry.userId !== userId) return entry
      if (entry.revokedAt) return entry
      if (exceptSessionId && entry.id === exceptSessionId) return entry
      count += 1
      return { ...entry, revokedAt }
    })
    if (count > 0) {
      await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    }
    return count
  }

  /**
   * List active (non-revoked) sessions for the user, newest first. Used by
   * the owner-only Team page "Active sessions" list.
   */
  async listActiveSessions(userId) {
    if (!userId) return []

    if (this.pool) {
      const result = await this.pool.query(
        `select id, user_id, created_at, last_seen_at, user_agent, ip_address
         from user_sessions
         where user_id = $1 and revoked_at is null
         order by last_seen_at desc`,
        [userId],
      )
      return result.rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
        userAgent: row.user_agent ?? null,
        ipAddress: row.ip_address ?? null,
      }))
    }

    const authState = await readJson(localAuthPath)
    return (authState.userSessions ?? [])
      .filter((entry) => entry.userId === userId && !entry.revokedAt)
      .slice()
      .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1))
      .map((entry) => ({
        id: entry.id,
        userId: entry.userId,
        createdAt: entry.createdAt,
        lastSeenAt: entry.lastSeenAt,
        userAgent: entry.userAgent ?? null,
        ipAddress: entry.ipAddress ?? null,
      }))
  }

  // ---- TOTP two-factor authentication ----

  /**
   * Read a user's TOTP-related fields. Returns null if no such user.
   * Includes both the active `totpSecret` (used for verify) and the
   * `pendingTotpSecret` (used during initial setup before the user has
   * proven they can read codes from their authenticator).
   */
  async getUserTotpState(userId) {
    if (!userId) return null

    if (this.pool) {
      const result = await this.pool.query(
        `select id, name, email, role, staff_role,
                totp_secret, totp_enabled, totp_backup_codes, pending_totp_secret
         from users where id = $1`,
        [userId],
      )
      if (!result.rowCount) return null
      const row = result.rows[0]
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        role: row.role,
        staffRole: row.staff_role,
        // Decrypt-at-rest (no-op passthrough for legacy plaintext / no key).
        totpSecret: decryptSecretAtRest(row.totp_secret ?? null),
        totpEnabled: Boolean(row.totp_enabled),
        totpBackupCodes: Array.isArray(row.totp_backup_codes) ? row.totp_backup_codes : [],
        pendingTotpSecret: decryptSecretAtRest(row.pending_totp_secret ?? null),
      }
    }

    const authState = await readJson(localAuthPath)
    const user = (authState.users ?? []).find((entry) => entry.id === userId)
    if (!user) return null
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      staffRole: user.staffRole,
      totpSecret: decryptSecretAtRest(user.totpSecret ?? null),
      totpEnabled: Boolean(user.totpEnabled),
      totpBackupCodes: Array.isArray(user.totpBackupCodes) ? user.totpBackupCodes : [],
      pendingTotpSecret: decryptSecretAtRest(user.pendingTotpSecret ?? null),
    }
  }

  /**
   * Save a candidate TOTP secret on the user row WITHOUT enabling 2FA.
   * Step 1 of the setup flow: the user has not yet proven they can read
   * codes from their app, so we keep the secret on a side field until
   * `commitTotp` fires.
   */
  async savePendingTotpSecret(userId, secret) {
    // Encrypted-at-rest when TOTP_ENC_KEY is set; unchanged plaintext otherwise.
    const stored = secret ? encryptSecretAtRest(secret) : null
    if (this.pool) {
      await this.pool.query(
        `update users set pending_totp_secret = $2, updated_at = now() where id = $1`,
        [userId, stored],
      )
      return
    }

    const authState = await readJson(localAuthPath)
    authState.users = (authState.users ?? []).map((user) =>
      user.id === userId ? { ...user, pendingTotpSecret: stored } : user,
    )
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
  }

  /**
   * Commit a verified TOTP secret + initial backup-code list. Clears the
   * pending field. Returns true on success.
   */
  async commitTotp(userId, secret, hashedBackupCodes) {
    if (!userId || !secret) return false

    // Encrypted-at-rest when TOTP_ENC_KEY is set; unchanged plaintext otherwise.
    const stored = encryptSecretAtRest(secret)

    if (this.pool) {
      const result = await this.pool.query(
        `update users
         set totp_secret = $2,
             totp_enabled = true,
             totp_backup_codes = $3,
             pending_totp_secret = null,
             updated_at = now()
         where id = $1
         returning id`,
        [userId, stored, hashedBackupCodes || []],
      )
      return result.rowCount > 0
    }

    const authState = await readJson(localAuthPath)
    let found = false
    authState.users = (authState.users ?? []).map((user) => {
      if (user.id !== userId) return user
      found = true
      return {
        ...user,
        totpSecret: stored,
        totpEnabled: true,
        totpBackupCodes: hashedBackupCodes || [],
        pendingTotpSecret: null,
      }
    })
    if (!found) return false
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return true
  }

  /**
   * Replace just the backup-code list (used by "Regenerate backup codes").
   */
  async replaceTotpBackupCodes(userId, hashedBackupCodes) {
    if (this.pool) {
      const result = await this.pool.query(
        `update users set totp_backup_codes = $2, updated_at = now() where id = $1 returning id`,
        [userId, hashedBackupCodes || []],
      )
      return result.rowCount > 0
    }

    const authState = await readJson(localAuthPath)
    let found = false
    authState.users = (authState.users ?? []).map((user) => {
      if (user.id !== userId) return user
      found = true
      return { ...user, totpBackupCodes: hashedBackupCodes || [] }
    })
    if (!found) return false
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return true
  }

  /**
   * After a backup code is consumed, persist the shortened list.
   */
  async setTotpBackupCodes(userId, hashedBackupCodes) {
    return this.replaceTotpBackupCodes(userId, hashedBackupCodes)
  }

  /**
   * Wipe all TOTP state on a user. Used by both the user-initiated "Disable"
   * (bookkeeper-only) and the owner-initiated "Reset 2FA" admin override.
   */
  async clearTotp(userId) {
    if (this.pool) {
      const result = await this.pool.query(
        `update users
         set totp_secret = null,
             totp_enabled = false,
             totp_backup_codes = '{}',
             pending_totp_secret = null,
             updated_at = now()
         where id = $1
         returning id`,
        [userId],
      )
      return result.rowCount > 0
    }

    const authState = await readJson(localAuthPath)
    let found = false
    authState.users = (authState.users ?? []).map((user) => {
      if (user.id !== userId) return user
      found = true
      return {
        ...user,
        totpSecret: null,
        totpEnabled: false,
        totpBackupCodes: [],
        pendingTotpSecret: null,
      }
    })
    if (!found) return false
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return true
  }

  /**
   * Create a 5-minute single-use pending-2fa token. Used between
   * /verify/:token and either /two-factor or /two-factor/setup. Set
   * `requiresSetup=true` when the user has not yet enabled 2FA but is being
   * forced into setup (currently: owners on first login).
   */
  async createPendingTwoFactor(userId, requiresSetup = false) {
    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + 1000 * 60 * 5)
    const createdAt = nowIso()

    if (this.pool) {
      await this.pool.query(
        `insert into pending_two_factor (token, user_id, requires_setup, expires_at, created_at)
         values ($1, $2, $3, $4, $5)`,
        [token, userId, Boolean(requiresSetup), expiresAt.toISOString(), createdAt],
      )
      return { token, expiresAt }
    }

    const authState = await readJson(localAuthPath)
    if (!Array.isArray(authState.pendingTwoFactor)) authState.pendingTwoFactor = []
    authState.pendingTwoFactor.push({
      token,
      userId,
      requiresSetup: Boolean(requiresSetup),
      attempts: 0,
      lockedAt: null,
      expiresAt: expiresAt.toISOString(),
      consumedAt: null,
      createdAt,
    })
    // Keep the list bounded — drop entries older than 1 hour.
    const cutoff = Date.now() - 1000 * 60 * 60
    authState.pendingTwoFactor = authState.pendingTwoFactor.filter(
      (entry) => new Date(entry.createdAt).getTime() > cutoff,
    )
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return { token, expiresAt }
  }

  /**
   * Look up (without consuming) a pending-2fa token. Returns null if missing,
   * expired, locked, or already consumed.
   */
  async getPendingTwoFactor(token) {
    if (!token) return null

    if (this.pool) {
      const result = await this.pool.query(
        `select token, user_id, requires_setup, attempts, locked_at, expires_at, consumed_at
         from pending_two_factor where token = $1`,
        [token],
      )
      if (!result.rowCount) return null
      const row = result.rows[0]
      if (row.consumed_at) return null
      if (row.locked_at) return null
      if (new Date(row.expires_at).getTime() <= Date.now()) return null
      return {
        token: row.token,
        userId: row.user_id,
        requiresSetup: Boolean(row.requires_setup),
        attempts: Number(row.attempts) || 0,
      }
    }

    const authState = await readJson(localAuthPath)
    const entry = (authState.pendingTwoFactor ?? []).find((e) => e.token === token)
    if (!entry) return null
    if (entry.consumedAt || entry.lockedAt) return null
    if (new Date(entry.expiresAt).getTime() <= Date.now()) return null
    return {
      token: entry.token,
      userId: entry.userId,
      requiresSetup: Boolean(entry.requiresSetup),
      attempts: Number(entry.attempts) || 0,
    }
  }

  /**
   * Increment the attempt counter on a pending-2fa token. After 5 attempts
   * the token is locked (caller must request a fresh email link). Returns
   * the new attempt count, or -1 if the token no longer exists.
   */
  async recordPendingTwoFactorAttempt(token) {
    if (!token) return -1

    if (this.pool) {
      const result = await this.pool.query(
        `update pending_two_factor
         set attempts = attempts + 1,
             locked_at = case when attempts + 1 >= 5 then now() else locked_at end
         where token = $1
         returning attempts`,
        [token],
      )
      if (!result.rowCount) return -1
      return Number(result.rows[0].attempts) || 0
    }

    const authState = await readJson(localAuthPath)
    let attempts = -1
    authState.pendingTwoFactor = (authState.pendingTwoFactor ?? []).map((entry) => {
      if (entry.token !== token) return entry
      const next = (Number(entry.attempts) || 0) + 1
      attempts = next
      return { ...entry, attempts: next, lockedAt: next >= 5 ? nowIso() : entry.lockedAt }
    })
    if (attempts === -1) return -1
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return attempts
  }

  /**
   * Mark a pending-2fa token consumed (single-shot). Called after a
   * successful TOTP verification or backup-code use, just before issuing
   * the full session cookie.
   */
  async consumePendingTwoFactor(token) {
    if (!token) return null
    const consumedAt = nowIso()

    if (this.pool) {
      const result = await this.pool.query(
        `update pending_two_factor
         set consumed_at = $2
         where token = $1 and consumed_at is null
         returning user_id, requires_setup`,
        [token, consumedAt],
      )
      if (!result.rowCount) return null
      return {
        userId: result.rows[0].user_id,
        requiresSetup: Boolean(result.rows[0].requires_setup),
      }
    }

    const authState = await readJson(localAuthPath)
    let consumed = null
    authState.pendingTwoFactor = (authState.pendingTwoFactor ?? []).map((entry) => {
      if (entry.token !== token || entry.consumedAt) return entry
      consumed = { userId: entry.userId, requiresSetup: Boolean(entry.requiresSetup) }
      return { ...entry, consumedAt }
    })
    if (!consumed) return null
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return consumed
  }

  async close() {
    if (this.pool) {
      await this.pool.end()
    }
  }
}
