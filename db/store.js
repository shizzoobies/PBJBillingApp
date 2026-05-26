import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
  return settings
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

async function readJson(filePath) {
  const content = await readFile(filePath, 'utf8')
  return JSON.parse(content)
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

  if (frequency === 'quarterly') {
    return addMonths(dateString, 3)
  }

  if (frequency === 'annually') {
    return addMonths(dateString, 12)
  }

  return addMonths(dateString, 1)
}

function normalizeClientProfile(client) {
  return {
    ...client,
    assignedBookkeeperIds: Array.isArray(client.assignedBookkeeperIds)
      ? [...new Set(client.assignedBookkeeperIds.filter((id) => typeof id === 'string'))]
      : [],
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
    quickbooksPayUrl: client.quickbooksPayUrl ?? '',
    invoiceShowTimeBreakdown:
      typeof client.invoiceShowTimeBreakdown === 'boolean' ? client.invoiceShowTimeBreakdown : true,
    invoiceHideInternalHours:
      typeof client.invoiceHideInternalHours === 'boolean' ? client.invoiceHideInternalHours : true,
    invoiceGroupByCategory:
      typeof client.invoiceGroupByCategory === 'boolean' ? client.invoiceGroupByCategory : false,
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
 * Resolve a stage's due date. An explicit `stage.dueDate` always wins over the
 * `offsetDays` calculation. Otherwise the due date is `baseDate` shifted by the
 * stage's `offsetDays`. Note: per-stage *repeat cadence* is not supported — the
 * template repeats as a whole; only the due date can be per-stage.
 */
function resolveStageDueDate(stage, baseDate) {
  if (stage && stage.dueDate) {
    return stage.dueDate
  }
  const offset = Number(stage && stage.offsetDays) || 0
  return offset ? addDays(baseDate, offset) : baseDate
}

/**
 * Day-of-month a specific-months template's checklist is due in `month` of
 * `year`. Honors `dueDayOfMonth` (capped to 28); falls back to the actual last
 * day of that month when unset. `month` is 1–12.
 */
function resolveSpecificMonthsDueDate(template, year, month) {
  const day =
    typeof template.dueDayOfMonth === 'number' &&
    template.dueDayOfMonth >= 1 &&
    template.dueDayOfMonth <= 28
      ? template.dueDayOfMonth
      : new Date(year, month, 0).getDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Normalize a raw sub-sub-items value (deepest level) into a clean
 * `{ id, title, done }[]`. Drops malformed entries. Sub-sub-items never nest
 * further. `withDone` controls whether `done` is included.
 */
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

function buildChecklistFromStage({ template, stage, stageIndex, stageCount, caseId, dueDate }) {
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
    items: stage.items.map((item) => ({
      id: `item-${randomUUID().slice(0, 8)}`,
      label: item.label,
      done: false,
      ...(item.dueDate ? { dueDate: item.dueDate } : {}),
      ...(item.assigneeId ? { assigneeId: item.assigneeId } : {}),
      ...(Array.isArray(item.subItems) && item.subItems.length > 0
        ? {
            subItems: item.subItems.map((sub) => ({
              id: `subitem-${randomUUID().slice(0, 8)}`,
              title: sub.title,
              done: false,
              ...(Array.isArray(sub.subItems) && sub.subItems.length > 0
                ? {
                    subItems: sub.subItems.map((subSub) => ({
                      id: `subsubitem-${randomUUID().slice(0, 8)}`,
                      title: subSub.title,
                      done: false,
                    })),
                  }
                : {}),
            })),
          }
        : {}),
    })),
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

function materializeRecurringChecklists(data) {
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

  const existingKeys = new Set(
    nextChecklists
      .filter((checklist) => checklist.templateId && checklist.dueDate)
      .map((checklist) => `${checklist.templateId}:${checklist.dueDate}:${checklist.stageIndex ?? 0}`),
  )

  // Year-month instance keys (`${templateId}:${YYYY-MM}`) for specific-months
  // templates — keep re-runs idempotent per designated month.
  const existingMonthKeys = new Set(
    nextChecklists
      .filter((checklist) => checklist.templateId && checklist.dueDate)
      .map((checklist) => `${checklist.templateId}:${String(checklist.dueDate).slice(0, 7)}`),
  )

  const todayDate = new Date()
  const currentYear = todayDate.getFullYear()

  for (const template of nextTemplates) {
    const stages = template.stages ?? []
    // Standard templates are blueprints only — they never materialize. A
    // specific-months template has no meaningful nextDueDate, so that guard is
    // skipped for it (handled in its own branch below).
    if (
      template.isStandard ||
      !template.active ||
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
      const months = Array.isArray(template.scheduledMonths) ? template.scheduledMonths : []
      for (const month of months) {
        if (!Number.isInteger(month) || month < 1 || month > 12) continue
        const monthStart = new Date(currentYear, month - 1, 1)
        if (todayDate < monthStart) continue
        const monthKey = `${template.id}:${currentYear}-${String(month).padStart(2, '0')}`
        if (existingMonthKeys.has(monthKey)) continue
        const stageOne = stages[0]
        const stageOneDue = resolveSpecificMonthsDueDate(template, currentYear, month)
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
        existingMonthKeys.add(monthKey)
        existingKeys.add(`${template.id}:${stageOneDue}:0`)
        changed = true
      }
      continue
    }

    let safetyCounter = 0
    while (template.nextDueDate <= today && safetyCounter < 60) {
      const instanceKey = `${template.id}:${template.nextDueDate}:0`

      if (!existingKeys.has(instanceKey)) {
        const stageOne = stages[0]
        const stageOneDue = resolveStageDueDate(stageOne, template.nextDueDate)
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
        existingKeys.add(instanceKey)
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

      // TOTP two-factor: per-user secret + enable flag + backup codes.
      // Stored as plaintext for v1 — encryption-at-rest at the DB layer is
      // the right defense (see lib/totp.js header). Backup codes are stored
      // pre-hashed (sha-256) so a DB read alone does not yield usable codes.
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

      await this.pool.query(`
        create table if not exists clients (
          id text primary key,
          name text not null,
          contact text not null,
          billing_mode text not null check (billing_mode in ('hourly', 'subscription')),
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
      await this.pool.query(
        `alter table clients add column if not exists invoice_show_time_breakdown boolean not null default true`,
      )
      await this.pool.query(
        `alter table clients add column if not exists invoice_hide_internal_hours boolean not null default true`,
      )
      await this.pool.query(
        `alter table clients add column if not exists invoice_group_by_category boolean not null default false`,
      )
      await this.pool.query(
        `alter table clients add column if not exists assigned_bookkeeper_ids text[] not null default '{}'`,
      )

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
          minutes integer not null check (minutes > 0),
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
      // Sub-bullets: one level of nested sub-items, stored as a JSONB array
      // ({ id, title, done }[]) directly on the item row. Least-invasive
      // choice given the existing schema; mirrors the `payload jsonb` pattern.
      await this.pool.query(
        `alter table checklist_items add column if not exists sub_items jsonb not null default '[]'::jsonb`,
      )

      await this.pool.query(`
        create table if not exists checklist_templates (
          id text primary key,
          title text not null,
          client_id text not null references clients(id) on delete cascade,
          assignee_id text not null references users(id) on delete restrict,
          frequency text not null check (frequency in ('daily', 'weekly', 'monthly', 'quarterly', 'annually')),
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
          check (frequency in ('daily', 'weekly', 'monthly', 'quarterly', 'annually', 'specific-months'))
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
      await this.pool.query(`alter table checklists add column if not exists case_id text`)
      await this.pool.query(`alter table checklists add column if not exists stage_id text`)
      await this.pool.query(`alter table checklists add column if not exists stage_index int`)
      await this.pool.query(`alter table checklists add column if not exists stage_count int`)

      await this.pool.query(`
        create table if not exists invoice_drafts (
          id text primary key,
          client_id text not null references clients(id) on delete restrict,
          billing_period text not null,
          status text not null default 'draft',
          total numeric(12, 2) not null default 0,
          payload jsonb not null default '{}'::jsonb,
          created_at timestamptz not null default now(),
          updated_at timestamptz not null default now(),
          unique (client_id, billing_period)
        )
      `)

      await this.seedUsersInPostgres()
      await this.seedRelationalDataInPostgres()
      await this.syncOwnerEmailInPostgres()
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

  async seedUsersInPostgres() {
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
    const result = await this.pool.query('select count(*)::int as count from clients')
    if (result.rows[0].count > 0) {
      return
    }

    const seed = await this.getSeedData()
    await this.write(seed)
  }

  async getSeedData() {
    return readJson(seedDataPath)
  }

  async read() {
    if (this.pool) {
      const [
        usersResult,
        plansResult,
        clientsResult,
        assignmentsResult,
        timeEntriesResult,
        checklistsResult,
        checklistItemsResult,
        checklistTemplatesResult,
        checklistTemplateItemsResult,
        checklistTemplateStagesResult,
        timesheetLocksResult,
        weeklySubmissionsResult,
      ] =
        await Promise.all([
          this.pool.query(`
            select id, name, role
            from users
            order by case when role = 'owner' then 0 else 1 end, name asc
          `),
          this.pool.query(`
            select id, name, monthly_fee, included_hours, notes
            from subscription_plans
            order by name asc
          `),
          this.pool.query(`
            select id, name, contact, billing_mode, hourly_rate, plan_id,
                   email, contact_name, phone, address_line1, address_line2,
                   city, state, postal_code, logo_url, payment_terms,
                   footer_note, quickbooks_pay_url, invoice_show_time_breakdown,
                   invoice_hide_internal_hours, invoice_group_by_category,
                   assigned_bookkeeper_ids
            from clients
            order by name asc
          `),
          this.pool.query(`
            select client_id, user_id
            from client_assignments
            order by client_id asc, user_id asc
          `),
          this.pool.query(`
            select id, user_id, client_id, entry_date, minutes, category, description, billable, task_id,
                   approval_status, approval_note, approved_by, approved_at, entry_method, manual_reason
            from time_entries
            order by entry_date desc, id desc
          `),
          this.pool.query(`
            select id, title, client_id, assignee_id, template_id, frequency, due_date, viewer_ids, editor_ids,
                   case_id, stage_id, stage_index, stage_count, deleted_at
            from checklists
            order by due_date asc, id asc
          `),
          this.pool.query(`
            select id, checklist_id, label, done, sort_order, due_date, assignee_id, sub_items
            from checklist_items
            order by checklist_id asc, sort_order asc, id asc
          `),
          this.pool.query(`
            select id, title, client_id, assignee_id, frequency, next_due_date, active, viewer_ids, editor_ids, is_standard,
                   scheduled_months, due_day_of_month
            from checklist_templates
            order by title asc
          `),
          this.pool.query(`
            select id, template_id, label, sort_order, due_date, assignee_id, stage_id, sub_items
            from checklist_template_items
            order by template_id asc, sort_order asc, id asc
          `),
          this.pool.query(`
            select id, template_id, name, assignee_id, offset_days, due_date, position, viewer_ids, editor_ids
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
        ])

      const assignmentsByClient = new Map()
      for (const row of assignmentsResult.rows) {
        const existing = assignmentsByClient.get(row.client_id) ?? []
        existing.push(row.user_id)
        assignmentsByClient.set(row.client_id, existing)
      }

      const itemsByChecklist = new Map()
      for (const row of checklistItemsResult.rows) {
        const existing = itemsByChecklist.get(row.checklist_id) ?? []
        const subItems = normalizeSubItems(row.sub_items, { withDone: true })
        const item = {
          id: row.id,
          label: row.label,
          done: row.done,
        }
        if (row.due_date) {
          item.dueDate = row.due_date.toISOString().slice(0, 10)
        }
        if (row.assignee_id) {
          item.assigneeId = row.assignee_id
        }
        if (subItems.length > 0) {
          item.subItems = subItems
          // `done` is derived for items with sub-items (which may themselves be
          // derived from sub-sub-items) — keep it in sync on read so a
          // hand-edited DB row can't desync the roll-up.
          item.done = rollUpItemDone(item)
        }
        existing.push(item)
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
        items: itemsByChecklist.get(row.id) ?? [],
        deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
      }))

      const data = {
        employees: usersResult.rows.map((row) => ({
          id: row.id,
          name: row.name,
          role: dbRoleToEmployeeRole(row.role),
        })),
        plans: plansResult.rows.map((row) => ({
          id: row.id,
          name: row.name,
          monthlyFee: Number(row.monthly_fee),
          includedHours: Number(row.included_hours),
          notes: row.notes,
        })),
        clients: clientsResult.rows.map((row) => ({
          id: row.id,
          name: row.name,
          contact: row.contact,
          billingMode: row.billing_mode,
          hourlyRate: Number(row.hourly_rate),
          planId: row.plan_id,
          assignedEmployeeIds: assignmentsByClient.get(row.id) ?? [],
          assignedBookkeeperIds: Array.isArray(row.assigned_bookkeeper_ids)
            ? [...new Set(row.assigned_bookkeeper_ids.filter((id) => typeof id === 'string'))]
            : [],
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
          invoiceHideInternalHours: row.invoice_hide_internal_hours ?? true,
          invoiceGroupByCategory: row.invoice_group_by_category ?? false,
        })),
        timeEntries: timeEntriesResult.rows.map((row) => ({
          id: row.id,
          employeeId: row.user_id,
          clientId: row.client_id,
          date: row.entry_date.toISOString().slice(0, 10),
          minutes: row.minutes,
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
          viewerIds: Array.isArray(row.viewer_ids) ? row.viewer_ids : [],
          editorIds: Array.isArray(row.editor_ids) ? row.editor_ids : [],
          // Specific-months scheduling fields (only meaningful for that frequency).
          scheduledMonths: Array.isArray(row.scheduled_months)
            ? row.scheduled_months.filter((m) => Number.isInteger(m) && m >= 1 && m <= 12)
            : [],
          ...(typeof row.due_day_of_month === 'number'
            ? { dueDayOfMonth: row.due_day_of_month }
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
      }

      if (data.checklistTemplates.length === 0) {
        const seed = await this.getSeedData()
        data.checklistTemplates = seed.checklistTemplates ?? []
      }

      data.firmSettings = await this.getFirmSettings()

      const materialized = materializeRecurringChecklists(data)
      if (materialized.changed) {
        await this.write(materialized.data)
        return materialized.data
      }

      return data
    }

    const data = await readJson(localDataPath)
    if (!Array.isArray(data.checklistTemplates)) {
      const seed = await this.getSeedData()
      data.checklistTemplates = seed.checklistTemplates ?? []
    }
    if (Array.isArray(data.clients)) {
      data.clients = data.clients.map(normalizeClientProfile)
    }
    data.firmSettings = { ...DEFAULT_FIRM_SETTINGS, ...(data.firmSettings || {}) }

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
      await writeFile(localDataPath, JSON.stringify(materialized.data, null, 2))
      return materialized.data
    }

    return data
  }

  async write(data) {
    if (this.pool) {
      const client = await this.pool.connect()

      try {
        await client.query('begin')
        await client.query('delete from checklist_items')
        await client.query('delete from checklists')
        await client.query('delete from checklist_template_items')
        await client.query('delete from checklist_template_stages')
        await client.query('delete from checklist_templates')
        await client.query('delete from time_entries')
        await client.query('delete from timesheet_locks')
        await client.query('delete from weekly_submissions')
        await client.query('delete from client_assignments')
        await client.query('delete from invoice_drafts')
        await client.query('delete from clients')
        await client.query('delete from subscription_plans')

        for (const employee of data.employees) {
          await client.query(
            `
              insert into users (id, name, email, role, staff_role, password_hash, updated_at)
              values ($1, $2, $3, $4, $5, coalesce((select password_hash from users where id = $1), $6), now())
              on conflict (id) do update
              set name = excluded.name,
                  email = excluded.email,
                  role = excluded.role,
                  staff_role = excluded.staff_role,
                  updated_at = now()
            `,
            [
              employee.id,
              employee.name,
              `${employee.id}@pbj.local`,
              roleToDbRole(employee.role),
              employee.role,
              hashPassword(demoPassword),
            ],
          )
        }

        for (const plan of data.plans) {
          await client.query(
            `
              insert into subscription_plans (id, name, monthly_fee, included_hours, notes, updated_at)
              values ($1, $2, $3, $4, $5, now())
            `,
            [plan.id, plan.name, plan.monthlyFee, plan.includedHours, plan.notes],
          )
        }

        for (const clientRecord of data.clients) {
          await client.query(
            `
              insert into clients (
                id, name, contact, billing_mode, hourly_rate, plan_id,
                email, contact_name, phone, address_line1, address_line2,
                city, state, postal_code, logo_url, payment_terms,
                footer_note, quickbooks_pay_url, invoice_show_time_breakdown,
                invoice_hide_internal_hours, invoice_group_by_category,
                assigned_bookkeeper_ids, updated_at
              )
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, now())
            `,
            [
              clientRecord.id,
              clientRecord.name,
              clientRecord.contact,
              clientRecord.billingMode,
              clientRecord.hourlyRate,
              clientRecord.planId,
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
              clientRecord.quickbooksPayUrl ?? '',
              clientRecord.invoiceShowTimeBreakdown ?? true,
              clientRecord.invoiceHideInternalHours ?? true,
              clientRecord.invoiceGroupByCategory ?? false,
              Array.isArray(clientRecord.assignedBookkeeperIds)
                ? clientRecord.assignedBookkeeperIds
                : [],
            ],
          )

          for (const employeeId of clientRecord.assignedEmployeeIds ?? []) {
            await client.query(
              `
                insert into client_assignments (client_id, user_id)
                values ($1, $2)
              `,
              [clientRecord.id, employeeId],
            )
          }
        }

        for (const entry of data.timeEntries) {
          await client.query(
            `
              insert into time_entries (id, user_id, client_id, entry_date, minutes, category, description, billable, task_id,
                                        approval_status, approval_note, approved_by, approved_at, entry_method, manual_reason, updated_at)
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
            `,
            [
              entry.id,
              entry.employeeId,
              entry.clientId,
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

        for (const submission of data.weeklySubmissions ?? []) {
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

        for (const template of data.checklistTemplates ?? []) {
          await client.query(
            `
              insert into checklist_templates (id, title, client_id, assignee_id, frequency, next_due_date, active, is_standard, viewer_ids, editor_ids, scheduled_months, due_day_of_month, updated_at)
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
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
            ],
          )

          // Stages-aware persistence. Migrate flat `items` into a synthetic
          // Stage 1 if the template still carries the legacy shape so writes
          // never lose data.
          const migratedTemplate = ensureTemplateStages(template)
          for (const [stageIdx, stage] of migratedTemplate.stages.entries()) {
            await client.query(
              `
                insert into checklist_template_stages (id, template_id, name, assignee_id, offset_days, due_date, position, viewer_ids, editor_ids, updated_at)
                values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
              `,
              [
                stage.id,
                template.id,
                stage.name,
                stage.assigneeId || null,
                Number(stage.offsetDays) || 0,
                stage.dueDate || null,
                stageIdx,
                Array.isArray(stage.viewerIds) ? stage.viewerIds : [],
                Array.isArray(stage.editorIds) ? stage.editorIds : [],
              ],
            )

            for (const [index, item] of (stage.items ?? []).entries()) {
              await client.query(
                `
                  insert into checklist_template_items (id, template_id, label, sort_order, due_date, assignee_id, stage_id, sub_items, updated_at)
                  values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())
                `,
                [
                  item.id,
                  template.id,
                  item.label,
                  index,
                  item.dueDate ?? null,
                  item.assigneeId ?? null,
                  stage.id,
                  JSON.stringify(normalizeSubItems(item.subItems, { withDone: false })),
                ],
              )
            }
          }
        }

        // Re-insert active and recycled checklists in one pass — the bulk
        // wipe above clears the table either way, so we'd lose the recycle
        // bin on every autosave if we only wrote `data.checklists` back.
        // `deletedAt` is the only distinguishing field on the row.
        const checklistsToWrite = [
          ...(Array.isArray(data.checklists) ? data.checklists : []),
          ...(Array.isArray(data.recycledChecklists) ? data.recycledChecklists : []),
        ]
        for (const checklist of checklistsToWrite) {
          await client.query(
            `
              insert into checklists (id, title, client_id, assignee_id, template_id, frequency, due_date, viewer_ids, editor_ids, case_id, stage_id, stage_index, stage_count, deleted_at, updated_at)
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now())
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
              checklist.deletedAt ?? null,
            ],
          )

          for (const [index, item] of checklist.items.entries()) {
            const subItems = normalizeSubItems(item.subItems, { withDone: true })
            // `done` is derived for items with sub-items (recursing through any
            // sub-sub-items) — persist the roll-up.
            const itemDone =
              subItems.length > 0 ? rollUpItemDone({ ...item, subItems }) : Boolean(item.done)
            await client.query(
              `
                insert into checklist_items (id, checklist_id, label, done, sort_order, due_date, assignee_id, sub_items, updated_at)
                values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())
              `,
              [
                item.id,
                checklist.id,
                item.label,
                itemDone,
                index,
                item.dueDate ?? null,
                item.assigneeId ?? null,
                JSON.stringify(subItems),
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

    await writeFile(localDataPath, JSON.stringify(data, null, 2))
  }

  async createTimeEntry(entry) {
    // New entries always enter the approval workflow as 'pending'. The capture
    // method defaults to 'timer'; only an explicit 'manual' entry carries a
    // reason — any non-manual entry drops manualReason entirely.
    const entryMethod = entry.entryMethod === 'manual' ? 'manual' : 'timer'
    const manualReason =
      entryMethod === 'manual' && typeof entry.manualReason === 'string'
        ? entry.manualReason
        : undefined
    const nextEntry = {
      ...entry,
      id: entry.id ?? `time-${randomUUID().slice(0, 8)}`,
      taskId: entry.taskId ?? null,
      approvalStatus: 'pending',
      entryMethod,
      manualReason,
    }

    if (this.pool) {
      await this.pool.query(
        `
          insert into time_entries (id, user_id, client_id, entry_date, minutes, category, description, billable, task_id, approval_status, entry_method, manual_reason, updated_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
        `,
        [
          nextEntry.id,
          nextEntry.employeeId,
          nextEntry.clientId,
          nextEntry.date,
          nextEntry.minutes,
          nextEntry.category ?? 'General',
          nextEntry.description,
          nextEntry.billable,
          nextEntry.taskId,
          nextEntry.approvalStatus,
          nextEntry.entryMethod,
          nextEntry.manualReason ?? null,
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
   * Look up a time entry by id from whichever backend is active.
   * Returns the app-shaped entry (camelCase) or null.
   */
  async getTimeEntry(entryId) {
    if (this.pool) {
      const result = await this.pool.query(
        `select id, user_id, client_id, entry_date, minutes, category, description, billable, task_id,
                approval_status, approval_note, approved_by, approved_at, entry_method, manual_reason
         from time_entries where id = $1`,
        [entryId],
      )
      if (!result.rowCount) return null
      const row = result.rows[0]
      return {
        id: row.id,
        employeeId: row.user_id,
        clientId: row.client_id,
        date: row.entry_date.toISOString().slice(0, 10),
        minutes: row.minutes,
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
    if (this.pool) {
      const setClauses = []
      const params = [entryId]
      const map = {
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
      }
      for (const [appKey, dbCol] of Object.entries(map)) {
        if (patch && Object.prototype.hasOwnProperty.call(patch, appKey)) {
          let value = patch[appKey]
          if ((appKey === 'taskId' || appKey === 'approvalNote' || appKey === 'approvedBy' ||
               appKey === 'approvedAt') && (value === '' || value === undefined)) {
            value = null
          }
          params.push(value)
          setClauses.push(`${dbCol} = $${params.length}`)
        }
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
        'minutes', 'description', 'billable', 'taskId', 'category', 'date',
        'approvalStatus', 'approvalNote', 'approvedBy', 'approvedAt',
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
   * Owner-only: replace the assigned-team list for a client. Filters owners
   * and unknown ids. Returns the updated client or null.
   */
  async setClientAssignedTeam(clientId, bookkeeperIds) {
    if (this.pool) {
      const usersResult = await this.pool.query(
        `select id from users where role <> 'owner'`,
      )
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
    const valid = new Set(
      employees.filter((e) => e.role !== 'Owner').map((e) => e.id),
    )
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

  async createChecklist(checklist) {
    const nextChecklist = {
      ...checklist,
      id: checklist.id ?? `check-${randomUUID().slice(0, 8)}`,
      viewerIds: Array.isArray(checklist.viewerIds) ? checklist.viewerIds : [],
      editorIds: Array.isArray(checklist.editorIds) ? checklist.editorIds : [],
      caseId: checklist.caseId ?? checklist.id ?? `case-${randomUUID().slice(0, 8)}`,
      stageId: checklist.stageId ?? null,
      stageIndex: typeof checklist.stageIndex === 'number' ? checklist.stageIndex : 0,
      stageCount: typeof checklist.stageCount === 'number' ? checklist.stageCount : 1,
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
            insert into checklists (id, title, client_id, assignee_id, template_id, frequency, due_date, viewer_ids, editor_ids, case_id, stage_id, stage_index, stage_count, updated_at)
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
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
          ],
        )

        for (const item of nextChecklist.items) {
          await client.query(
            `
              insert into checklist_items (id, checklist_id, label, done, sort_order, due_date, assignee_id, sub_items, updated_at)
              values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now())
            `,
            [
              item.id,
              nextChecklist.id,
              item.label,
              item.done,
              item.sortOrder,
              item.dueDate ?? null,
              item.assigneeId ?? null,
              JSON.stringify(Array.isArray(item.subItems) ? item.subItems : []),
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
         set done = $3, sub_items = $4::jsonb, updated_at = now()
         where checklist_id = $1 and id = $2`,
        [checklistId, itemId, toggled.done, JSON.stringify(toggled.subItems)],
      )

      const data = await this.read()
      const updated = data.checklists.find((checklist) => checklist.id === checklistId) ?? null
      const spawn = await this.maybeSpawnNextStage(data, updated)
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
          ? { ...item, subItems: toggled.subItems, done: toggled.done }
          : { ...item, done: toggled.done }
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
    const { title, dueDate, assigneeId } = patch ?? {}

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
         set sub_items = $3::jsonb, done = $4, updated_at = now()
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
        return { ...item, subItems: nextSubItems, done: nextSubItems.every((sub) => sub.done) }
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
         set sub_items = $3::jsonb, done = $4, updated_at = now()
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
        return { ...item, subItems: nextSubItems, done: nextDone }
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
         set sub_items = $3::jsonb, done = $4, updated_at = now()
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
        return { ...item, subItems: nextSubItems, done: nextSubItems.every((sub) => sub.done) }
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
         set sub_items = $3::jsonb, done = $4, updated_at = now()
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
        return { ...item, subItems: nextSubItems, done: nextSubItems.every((sub) => sub.done) }
      })
      updatedChecklist = { ...checklist, items }
      return updatedChecklist
    })
    if (!subSubItemFound || !updatedChecklist) return null
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return updatedChecklist
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
      const result = await this.pool.query(`
        select id, name, email, role, staff_role, magic_token, token_revoked_at, last_active_at, created_at,
               totp_enabled
        from users
        order by case when role = 'owner' then 0 else 1 end, name asc
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
      }))
    }

    const authState = await readJson(localAuthPath)
    return (authState.users ?? []).map((user) => ({
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
    }))
  }

  async getTeamMember(userId) {
    const members = await this.getTeamMembers()
    return members.find((member) => member.id === userId) ?? null
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
    const passwordHash = hashPassword(demoPassword)
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
   * Remove a team member without barriers: reassigns every FK-blocking
   * reference (checklists, templates, template stages, time entries) to the
   * calling owner so billing history and in-flight work survive, clears the
   * user from every viewer / editor / assigned-team array, deletes their
   * timesheet locks, then drops the user row. Wrapped in a single Postgres
   * transaction so a failure mid-way doesn't leave a half-removed user.
   *
   * `ownerId` is the id of the owner performing the delete — used as the new
   * assignee for anything that has a NOT NULL assignee FK. The owner can
   * triage the reassigned items afterwards (the recycle bin handles tasks
   * they want gone entirely).
   *
   * Returns `{ ok: true }` on success or `{ ok: false, reason: 'not_found' }`
   * when no matching user exists. No more `has_checklists` rejection — the
   * cleanup above guarantees the final DELETE never violates a FK.
   */
  async deleteTeamMember(userId, ownerId) {
    if (this.pool) {
      const client = await this.pool.connect()
      try {
        await client.query('begin')

        // Reassign every NOT NULL assignee_id FK to the owner so the final
        // DELETE doesn't trip `on delete restrict`. Covers active AND
        // recycled checklists — both still carry the foreign-key reference.
        await client.query(
          `update checklists set assignee_id = $1 where assignee_id = $2`,
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

        // Per-item assignee columns are nullable text (no FK). Just clear
        // them so the owner sees an unassigned step rather than a ghost name.
        await client.query(
          `update checklist_items set assignee_id = null where assignee_id = $1`,
          [userId],
        )
        await client.query(
          `update checklist_template_items set assignee_id = null where assignee_id = $1`,
          [userId],
        )

        // Viewer / editor arrays carry no FK — strip the id everywhere it
        // could grant lingering visibility. `array_remove` is a no-op when
        // the id is absent, so the where-guard is purely an optimisation.
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

        // Client-level assigned-team list (the dropdown source used by the
        // time-tracking scope) — strip the removed user from every client.
        await client.query(
          `update clients
             set assigned_bookkeeper_ids = array_remove(assigned_bookkeeper_ids, $1)
             where $1 = any(assigned_bookkeeper_ids)`,
          [userId],
        )

        // Time entries: reassign to the owner so billing history survives
        // (the FK is `on delete restrict`, so leaving them dangling isn't an
        // option). The owner now sees those hours under their name — a
        // deliberate trade for keeping the data alive after a user is gone.
        await client.query(
          `update time_entries set user_id = $1 where user_id = $2`,
          [ownerId, userId],
        )
        // `approved_by` is a plain text column with no FK; null it so the
        // approval audit doesn't point at a missing user.
        await client.query(
          `update time_entries set approved_by = null where approved_by = $1`,
          [userId],
        )

        // Timesheet locks are per-user metadata; nothing else references them.
        await client.query(
          `delete from timesheet_locks where user_id = $1 or locked_by = $1`,
          [userId],
        )

        // `client_assignments.user_id` cascades automatically when the user
        // row goes. Finally drop the user themselves.
        const result = await client.query(
          `delete from users where id = $1 returning id`,
          [userId],
        )
        if (!result.rowCount) {
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
      assigneeId: checklist.assigneeId === userId ? ownerId : checklist.assigneeId,
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

    data.timeEntries = (data.timeEntries ?? []).map((entry) => ({
      ...entry,
      employeeId: entry.employeeId === userId ? ownerId : entry.employeeId,
      ...(entry.approvedBy === userId ? { approvedBy: undefined } : {}),
    }))

    data.timesheetLocks = (data.timesheetLocks ?? []).filter(
      (lock) => lock.userId !== userId && lock.lockedBy !== userId,
    )

    await writeFile(localDataPath, JSON.stringify(data, null, 2))

    const authState = await readJson(localAuthPath)
    const before = (authState.users ?? []).length
    authState.users = (authState.users ?? []).filter((user) => user.id !== userId)
    if (authState.users.length === before) {
      return { ok: false, reason: 'not_found' }
    }
    authState.sessions = (authState.sessions ?? []).filter((session) => session.userId !== userId)
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
    if (stages.length === 0 || (stages[0].items ?? []).length === 0) return null
    const stageOne = stages[0]
    const baseDate = typeof dueDate === 'string' && dueDate
      ? dueDate
      : template.nextDueDate || formatDateOnly(new Date())
    const stageOneDue = resolveStageDueDate(stageOne, baseDate)
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
        `select name, tagline, logo_url, brand_color, address_line1, address_line2,
                city, state, postal_code, phone, email, website, ein
           from firm_settings where id = 'singleton'`,
      )
      return rowToFirmSettings(result.rows[0])
    }
    const data = await readJson(localDataPath)
    const stored = data.firmSettings || {}
    return { ...DEFAULT_FIRM_SETTINGS, ...stored }
  }

  async updateFirmSettings(patch) {
    const current = await this.getFirmSettings()
    const next = { ...current }
    for (const [appKey] of FIRM_SETTINGS_FIELDS) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, appKey)) {
        const value = patch[appKey]
        if (typeof value === 'string') {
          next[appKey] = value
        } else if (value === null || value === undefined) {
          next[appKey] = appKey === 'name' ? DEFAULT_FIRM_SETTINGS.name : ''
        }
      }
    }
    if (!next.name || !next.name.trim()) {
      next.name = DEFAULT_FIRM_SETTINGS.name
    }

    if (this.pool) {
      await this.pool.query(
        `insert into firm_settings (id, name, tagline, logo_url, brand_color,
            address_line1, address_line2, city, state, postal_code,
            phone, email, website, ein, updated_at)
         values ('singleton', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
         on conflict (id) do update set
            name = excluded.name,
            tagline = excluded.tagline,
            logo_url = excluded.logo_url,
            brand_color = excluded.brand_color,
            address_line1 = excluded.address_line1,
            address_line2 = excluded.address_line2,
            city = excluded.city,
            state = excluded.state,
            postal_code = excluded.postal_code,
            phone = excluded.phone,
            email = excluded.email,
            website = excluded.website,
            ein = excluded.ein,
            updated_at = now()`,
        [
          next.name,
          next.tagline || null,
          next.logoUrl || null,
          next.brandColor || null,
          next.addressLine1 || null,
          next.addressLine2 || null,
          next.city || null,
          next.state || null,
          next.postalCode || null,
          next.phone || null,
          next.email || null,
          next.website || null,
          next.ein || null,
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
      const result = await this.pool.query(
        `select id, name, email, role, staff_role from users where lower(email) = $1`,
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
      }
    }

    const authState = await readJson(localAuthPath)
    const user = (authState.users ?? []).find(
      (entry) => entry.email && entry.email.toLowerCase() === trimmed,
    )
    if (!user) return null
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      staffRole: user.staffRole,
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
   * Validate and consume a sign-in link token. Returns { userId } on success
   * or null if the token is unknown, expired, or already consumed.
   */
  async consumeLoginToken(token) {
    if (!token) return null
    const consumedAt = nowIso()

    if (this.pool) {
      const result = await this.pool.query(
        `update login_tokens
         set consumed_at = $2
         where token = $1
           and consumed_at is null
           and expires_at > now()
         returning user_id`,
        [token, consumedAt],
      )
      if (!result.rowCount) return null
      return { userId: result.rows[0].user_id }
    }

    const authState = await readJson(localAuthPath)
    let consumed = null
    authState.loginTokens = (authState.loginTokens ?? []).map((entry) => {
      if (entry.token !== token) return entry
      if (entry.consumedAt) return entry
      if (new Date(entry.expiresAt).getTime() <= Date.now()) return entry
      consumed = { userId: entry.userId }
      return { ...entry, consumedAt }
    })
    if (!consumed) return null
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    return consumed
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
   * Boot-time owner password bootstrap. If `OWNER_BOOTSTRAP_PASSWORD` is set
   * in the environment, the first owner user's `password_hash` is reset to
   * a fresh hash of that value. Idempotent: a no-op when the current hash
   * already verifies the env value (so flipping the var off doesn't lock
   * anyone out, and a redeploy with the same value is harmless). Never
   * logs the password — only the user id on success.
   *
   * This is the bulletproof recovery path for the owner: set the var on
   * Railway, redeploy, sign in with email + that password. Magic links
   * stay untouched as a secondary auth method.
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
      if (owner.password_hash && verifyPassword(password, owner.password_hash)) {
        console.log('[bootstrap] owner password already matches env var — no change')
        return false
      }
      await this.pool.query(
        `update users set password_hash = $1, updated_at = now() where id = $2`,
        [hashPassword(password), owner.id],
      )
      console.log(`[bootstrap] owner password reset for user id ${owner.id}`)
      return true
    }

    const authState = await readJson(localAuthPath)
    const owner = (authState.users ?? []).find((user) => user.role === 'owner')
    if (!owner) {
      console.log('[bootstrap] OWNER_BOOTSTRAP_PASSWORD is set but no owner user exists')
      return false
    }
    if (owner.passwordHash && verifyPassword(password, owner.passwordHash)) {
      return false
    }
    owner.passwordHash = hashPassword(password)
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
    console.log(`[bootstrap] owner password reset for user id ${owner.id} (file mode)`)
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
         where s.id = $1`,
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
    if (!user) return null
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
        totpSecret: row.totp_secret ?? null,
        totpEnabled: Boolean(row.totp_enabled),
        totpBackupCodes: Array.isArray(row.totp_backup_codes) ? row.totp_backup_codes : [],
        pendingTotpSecret: row.pending_totp_secret ?? null,
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
      totpSecret: user.totpSecret ?? null,
      totpEnabled: Boolean(user.totpEnabled),
      totpBackupCodes: Array.isArray(user.totpBackupCodes) ? user.totpBackupCodes : [],
      pendingTotpSecret: user.pendingTotpSecret ?? null,
    }
  }

  /**
   * Save a candidate TOTP secret on the user row WITHOUT enabling 2FA.
   * Step 1 of the setup flow: the user has not yet proven they can read
   * codes from their app, so we keep the secret on a side field until
   * `commitTotp` fires.
   */
  async savePendingTotpSecret(userId, secret) {
    if (this.pool) {
      await this.pool.query(
        `update users set pending_totp_secret = $2, updated_at = now() where id = $1`,
        [userId, secret || null],
      )
      return
    }

    const authState = await readJson(localAuthPath)
    authState.users = (authState.users ?? []).map((user) =>
      user.id === userId ? { ...user, pendingTotpSecret: secret || null } : user,
    )
    await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
  }

  /**
   * Commit a verified TOTP secret + initial backup-code list. Clears the
   * pending field. Returns true on success.
   */
  async commitTotp(userId, secret, hashedBackupCodes) {
    if (!userId || !secret) return false

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
        [userId, secret, hashedBackupCodes || []],
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
        totpSecret: secret,
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
