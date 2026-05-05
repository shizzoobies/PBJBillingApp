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

const seededUsers = [
  {
    id: 'emp-patrice',
    name: 'Patrice Bell',
    email: 'owner@pbj.local',
    staffRole: 'Owner',
    role: 'owner',
  },
  {
    id: 'emp-avery',
    name: 'Avery Johnson',
    email: 'avery@pbj.local',
    staffRole: 'Senior Bookkeeper',
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

  if (role === 'Senior Bookkeeper') {
    return 'senior_bookkeeper'
  }

  return 'bookkeeper'
}

function dbRoleToEmployeeRole(role) {
  if (role === 'owner') {
    return 'Owner'
  }

  if (role === 'senior_bookkeeper') {
    return 'Senior Bookkeeper'
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
    })),
  }
}

function materializeRecurringChecklists(data) {
  const templates = Array.isArray(data.checklistTemplates) ? data.checklistTemplates : []
  if (templates.length === 0) {
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

  for (const template of nextTemplates) {
    const stages = template.stages ?? []
    if (!template.active || !template.nextDueDate || stages.length === 0 || stages[0].items.length === 0) {
      continue
    }

    let safetyCounter = 0
    while (template.nextDueDate <= today && safetyCounter < 60) {
      const instanceKey = `${template.id}:${template.nextDueDate}:0`

      if (!existingKeys.has(instanceKey)) {
        const stageOne = stages[0]
        const stageOneDue = stageOne.offsetDays
          ? addDays(template.nextDueDate, Number(stageOne.offsetDays))
          : template.nextDueDate
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

  if (!changed) {
    return { changed: false, data }
  }

  return {
    changed: true,
    data: {
      ...data,
      checklistTemplates: nextTemplates,
      checklists: sortChecklists(nextChecklists),
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
  const offset = Number(nextStage.offsetDays) || 0
  const dueDate = offset
    ? addDays(justCompletedChecklist.dueDate, offset)
    : justCompletedChecklist.dueDate
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
          { users: createSeededAuthUsers(), sessions: [], activityLog: [], notifications: [] },
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
      if (mutated) {
        await writeFile(localAuthPath, JSON.stringify(authState, null, 2))
      }
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
                   invoice_hide_internal_hours, invoice_group_by_category
            from clients
            order by name asc
          `),
          this.pool.query(`
            select client_id, user_id
            from client_assignments
            order by client_id asc, user_id asc
          `),
          this.pool.query(`
            select id, user_id, client_id, entry_date, minutes, category, description, billable
            from time_entries
            order by entry_date desc, id desc
          `),
          this.pool.query(`
            select id, title, client_id, assignee_id, template_id, frequency, due_date, viewer_ids, editor_ids,
                   case_id, stage_id, stage_index, stage_count
            from checklists
            order by due_date asc, id asc
          `),
          this.pool.query(`
            select id, checklist_id, label, done, sort_order, due_date, assignee_id
            from checklist_items
            order by checklist_id asc, sort_order asc, id asc
          `),
          this.pool.query(`
            select id, title, client_id, assignee_id, frequency, next_due_date, active, viewer_ids, editor_ids
            from checklist_templates
            order by title asc
          `),
          this.pool.query(`
            select id, template_id, label, sort_order, due_date, assignee_id, stage_id
            from checklist_template_items
            order by template_id asc, sort_order asc, id asc
          `),
          this.pool.query(`
            select id, template_id, name, assignee_id, offset_days, position, viewer_ids, editor_ids
            from checklist_template_stages
            order by template_id asc, position asc, id asc
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
        const list = stagesByTemplate.get(row.template_id) ?? []
        list.push(stage)
        stagesByTemplate.set(row.template_id, list)
      }

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
        })),
        checklists: checklistsResult.rows.map((row) => ({
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
        })),
        checklistTemplates: checklistTemplatesResult.rows.map((row) => ({
          id: row.id,
          title: row.title,
          clientId: row.client_id,
          assigneeId: row.assignee_id,
          frequency: row.frequency,
          nextDueDate: row.next_due_date.toISOString().slice(0, 10),
          active: row.active,
          viewerIds: Array.isArray(row.viewer_ids) ? row.viewer_ids : [],
          editorIds: Array.isArray(row.editor_ids) ? row.editor_ids : [],
          stages: stagesByTemplate.get(row.id) ?? [],
          items: templateItemsByTemplate.get(row.id) ?? [],
        })),
      }

      if (data.checklistTemplates.length === 0) {
        const seed = await this.getSeedData()
        data.checklistTemplates = seed.checklistTemplates ?? []
      }

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
    const materialized = materializeRecurringChecklists(data)
    if (materialized.changed) {
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
                invoice_hide_internal_hours, invoice_group_by_category, updated_at
              )
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, now())
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
              insert into time_entries (id, user_id, client_id, entry_date, minutes, category, description, billable, updated_at)
              values ($1, $2, $3, $4, $5, $6, $7, $8, now())
            `,
            [entry.id, entry.employeeId, entry.clientId, entry.date, entry.minutes, entry.category, entry.description, entry.billable],
          )
        }

        for (const template of data.checklistTemplates ?? []) {
          await client.query(
            `
              insert into checklist_templates (id, title, client_id, assignee_id, frequency, next_due_date, active, viewer_ids, editor_ids, updated_at)
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
            `,
            [
              template.id,
              template.title,
              template.clientId,
              template.assigneeId,
              template.frequency,
              template.nextDueDate,
              template.active,
              Array.isArray(template.viewerIds) ? template.viewerIds : [],
              Array.isArray(template.editorIds) ? template.editorIds : [],
            ],
          )

          // Stages-aware persistence. Migrate flat `items` into a synthetic
          // Stage 1 if the template still carries the legacy shape so writes
          // never lose data.
          const migratedTemplate = ensureTemplateStages(template)
          for (const [stageIdx, stage] of migratedTemplate.stages.entries()) {
            await client.query(
              `
                insert into checklist_template_stages (id, template_id, name, assignee_id, offset_days, position, viewer_ids, editor_ids, updated_at)
                values ($1, $2, $3, $4, $5, $6, $7, $8, now())
              `,
              [
                stage.id,
                template.id,
                stage.name,
                stage.assigneeId || null,
                Number(stage.offsetDays) || 0,
                stageIdx,
                Array.isArray(stage.viewerIds) ? stage.viewerIds : [],
                Array.isArray(stage.editorIds) ? stage.editorIds : [],
              ],
            )

            for (const [index, item] of (stage.items ?? []).entries()) {
              await client.query(
                `
                  insert into checklist_template_items (id, template_id, label, sort_order, due_date, assignee_id, stage_id, updated_at)
                  values ($1, $2, $3, $4, $5, $6, $7, now())
                `,
                [item.id, template.id, item.label, index, item.dueDate ?? null, item.assigneeId ?? null, stage.id],
              )
            }
          }
        }

        for (const checklist of data.checklists) {
          await client.query(
            `
              insert into checklists (id, title, client_id, assignee_id, template_id, frequency, due_date, viewer_ids, editor_ids, case_id, stage_id, stage_index, stage_count, updated_at)
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
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
            ],
          )

          for (const [index, item] of checklist.items.entries()) {
            await client.query(
              `
                insert into checklist_items (id, checklist_id, label, done, sort_order, due_date, assignee_id, updated_at)
                values ($1, $2, $3, $4, $5, $6, $7, now())
              `,
              [item.id, checklist.id, item.label, item.done, index, item.dueDate ?? null, item.assigneeId ?? null],
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
    const nextEntry = {
      ...entry,
      id: entry.id ?? `time-${randomUUID().slice(0, 8)}`,
    }

    if (this.pool) {
      await this.pool.query(
        `
          insert into time_entries (id, user_id, client_id, entry_date, minutes, category, description, billable, updated_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8, now())
        `,
        [
          nextEntry.id,
          nextEntry.employeeId,
          nextEntry.clientId,
          nextEntry.date,
          nextEntry.minutes,
          nextEntry.category,
          nextEntry.description,
          nextEntry.billable,
        ],
      )

      return nextEntry
    }

    const data = await readJson(localDataPath)
    data.timeEntries = [nextEntry, ...data.timeEntries]
    await writeFile(localDataPath, JSON.stringify(data, null, 2))
    return nextEntry
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
      items: checklist.items.map((item, index) => ({
        ...item,
        id: item.id ?? `item-${randomUUID().slice(0, 8)}`,
        done: Boolean(item.done),
        sortOrder: index,
        dueDate: item.dueDate ?? null,
        assigneeId: item.assigneeId ?? null,
      })),
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
              insert into checklist_items (id, checklist_id, label, done, sort_order, due_date, assignee_id, updated_at)
              values ($1, $2, $3, $4, $5, $6, $7, now())
            `,
            [item.id, nextChecklist.id, item.label, item.done, item.sortOrder, item.dueDate ?? null, item.assigneeId ?? null],
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

  async toggleChecklistItem(checklistId, itemId) {
    if (this.pool) {
      const result = await this.pool.query(
        `
          update checklist_items
          set done = not done,
              updated_at = now()
          where checklist_id = $1 and id = $2
          returning checklist_id
        `,
        [checklistId, itemId],
      )

      if (!result.rowCount) {
        return null
      }

      const data = await this.read()
      const updated = data.checklists.find((checklist) => checklist.id === checklistId) ?? null
      const spawn = await this.maybeSpawnNextStage(data, updated)
      return { checklist: updated, spawned: spawn }
    }

    const data = await readJson(localDataPath)
    let updatedChecklist = null

    data.checklists = data.checklists.map((checklist) => {
      if (checklist.id !== checklistId) {
        return checklist
      }

      let itemUpdated = false
      const items = checklist.items.map((item) => {
        if (item.id !== itemId) {
          return item
        }

        itemUpdated = true
        return {
          ...item,
          done: !item.done,
        }
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
    return this.createChecklist(spawn)
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
          where id = $1
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
        `select id from checklists where id = $1`,
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
        select id, name, email, role, staff_role, magic_token, token_revoked_at, last_active_at, created_at
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
    }))
  }

  async getTeamMember(userId) {
    const members = await this.getTeamMembers()
    return members.find((member) => member.id === userId) ?? null
  }

  async createTeamMember({ name, email, staffRole }) {
    const trimmedName = String(name ?? '').trim()
    const trimmedEmail = String(email ?? '').trim().toLowerCase()
    const safeStaffRole = ['Owner', 'Senior Bookkeeper', 'Bookkeeper'].includes(staffRole)
      ? staffRole
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

  async deleteTeamMember(userId) {
    if (this.pool) {
      const assignedResult = await this.pool.query(
        `select 1 from checklists where assignee_id = $1 limit 1`,
        [userId],
      )
      if (assignedResult.rowCount) {
        return { ok: false, reason: 'has_checklists' }
      }
      const result = await this.pool.query('delete from users where id = $1 returning id', [userId])
      if (!result.rowCount) {
        return { ok: false, reason: 'not_found' }
      }
      return { ok: true }
    }

    const data = await readJson(localDataPath)
    const hasChecklist = (data.checklists ?? []).some((checklist) => checklist.assigneeId === userId)
    if (hasChecklist) {
      return { ok: false, reason: 'has_checklists' }
    }
    const hasTemplate = (data.checklistTemplates ?? []).some(
      (template) => template.assigneeId === userId,
    )
    if (hasTemplate) {
      return { ok: false, reason: 'has_checklists' }
    }

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

  async close() {
    if (this.pool) {
      await this.pool.end()
    }
  }
}
