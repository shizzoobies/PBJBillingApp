#!/usr/bin/env node
// Merges a duplicate client record into the client that is being kept, by
// re-pointing every reference in the database at the survivor and then RETIRING
// the duplicate row. Postgres only — this walks the live production schema and
// has no JSON-file-backend equivalent; it refuses to run without a connection
// string.
//
//   node scripts/prod/merge-client.mjs <duplicateId> <survivorId>                dry run (rolled back)
//   node scripts/prod/merge-client.mjs <duplicateId> <survivorId> --apply        write it, snapshot first
//   node scripts/prod/merge-client.mjs <duplicateId> <survivorId> --apply --i-know
//   node scripts/prod/merge-client.mjs --undo docs/prod-snapshots/<stamp>-merge-<dup>-into-<survivor>.json [--apply]
//
// `--i-know` is required when the duplicate owns invoices that have left draft
// (sent / processing / paid): those documents move to the survivor, and a client
// who has already seen one should be told the name on it changed.
//
// WHY THE DUPLICATE ROW IS RETIRED AND NEVER DELETED
// --------------------------------------------------
// Eight of the columns that hold a client id carry no foreign key at all:
// checklist_skips.client_id, client_notes.client_id,
// item_deletion_requests.client_id, sales_tax_records.client_id,
// invoice_review_events.client_id, invoice_ai_reviews.client_id,
// clients.bill_to_client_id and clients.invoice_recipient_client_id — and
// neither do the array/jsonb references (time_entries.group_client_ids,
// clients.plan_ids / contact_ids / assigned_bookkeeper_ids,
// invoices.line_items[].sourceClientId). The database will happily let a row
// point at a client id that no longer exists. Worse, `cleanupOrphanedClientData`
// in db/store.js HARD-DELETES checklists, checklist items, template items and
// template stages whose client_id is not in `clients`, so a deleted client turns
// into silently destroyed work the next time that sweep runs. And a dangling id
// in `clients.plan_ids[]` is exactly what caused the 2026-06-17 full outage —
// every bulk write crashed until the reference was cleaned out. So the duplicate
// stays in the table, marked inactive, with its name annotated. Its plan_ids and
// contact_ids are left untouched on purpose: `--undo` needs them.
//
// Under `--apply` a snapshot is written to docs/prod-snapshots/ BEFORE the
// transaction opens (both full client rows, every moved row id, the invoice jsonb
// before its rewrite, and the per-table counts) and should be committed. The
// forward run and the undo both re-select and verify inside the transaction and
// throw — rolling the whole thing back — on any mismatch.
//
// Connection string: DATABASE_PUBLIC_URL / DATABASE_URL in the environment, else
// the Railway CLI.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Client } = require('pg')

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const iKnow = args.includes('--i-know')
const undoIndex = args.indexOf('--undo')
const undoPath = undoIndex >= 0 ? args[undoIndex + 1] : null
const positional = args.filter((a) => !a.startsWith('--') && a !== undoPath)
const duplicateId = positional[0]
const survivorId = positional[1]

const USAGE = [
  'Usage:',
  '  node scripts/prod/merge-client.mjs <duplicateId> <survivorId> [--apply] [--i-know]',
  '  node scripts/prod/merge-client.mjs --undo <snapshot.json> [--apply]',
].join('\n')

// Tables that hold a plain client_id and are moved wholesale, in the order they
// are written. `invoices` is moved by client_id ONLY: its number, total and
// status are never touched.
const CHILD_TABLES = [
  'time_entries',
  'checklists',
  'checklist_templates',
  'checklist_skips',
  'reimbursements',
  'recurring_reimbursements',
  'client_notes',
  'item_deletion_requests',
  'sales_tax_records',
  'invoices',
  'invoice_review_events',
  'invoice_ai_reviews',
]

// checklist_items / checklist_template_items / checklist_template_stages key on
// checklist_id / template_id and follow their parent for free. weekly_submissions
// is user-scoped and holds no client id.
const ONBOARDING_TABLES = ['checklists', 'checklist_templates']
const CLIENT_POINTER_COLUMNS = ['bill_to_client_id', 'invoice_recipient_client_id']

// Survivor scalars: filled in from the duplicate ONLY where the survivor has
// nothing. A value the survivor already carries is never overwritten.
const TEXT_FILL_COLUMNS = [
  'email',
  'phone',
  'contact',
  'contact_name',
  'address_line1',
  'address_line2',
  'city',
  'state',
  'postal_code',
  'logo_url',
  'payment_terms',
  'footer_note',
  'quickbooks_pay_url',
  'monthly_service_tier',
]
const NUMERIC_FILL_COLUMNS = [
  'hourly_rate',
  'monthly_rate',
  'annual_rate',
  'custom_monthly_fee',
  'estimated_monthly_hours',
  'estimated_bookkeeper_hours',
  'estimated_accountant_hours',
  'estimated_cfo_hours',
  'annual_billing_month',
]
// Booleans, invoice_time_breakdown_mode and stripe_customer_id are deliberately
// absent: they are settings a person chose for the surviving client, and a
// duplicate's defaults must not quietly change how its invoices print or which
// Stripe customer it bills.

const ARRAY_UNIONS = [
  { column: 'plan_ids', validates: 'subscription_plans' },
  { column: 'contact_ids', validates: 'contacts' },
  { column: 'assigned_bookkeeper_ids', validates: 'users' },
]

// Reported, never rewritten: free text that happens to mention the duplicate id.
const FREE_TEXT_SCANS = [
  { table: 'activity_log', columns: ['target'] },
  { table: 'notifications', columns: ['payload', 'link'] },
  { table: 'feature_requests', wholeRow: true },
  { table: 'assistant_messages', wholeRow: true },
  { table: 'spitball_sessions', wholeRow: true },
]

function connectionString() {
  const fromEnv = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL
  if (fromEnv) return fromEnv
  let out
  try {
    out = execFileSync(
      'npx',
      ['@railway/cli@latest', 'variables', '--service', 'Postgres', '--json'],
      { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'inherit'] },
    )
  } catch {
    throw new Error(
      'no Postgres connection string: set DATABASE_PUBLIC_URL or DATABASE_URL, or log in to the Railway CLI. This script is Postgres-only.',
    )
  }
  const url = JSON.parse(out).DATABASE_PUBLIC_URL
  if (!url) {
    throw new Error(
      'no Postgres connection string: DATABASE_PUBLIC_URL missing from railway variables output. This script is Postgres-only.',
    )
  }
  return url
}

const db = new Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } })

// ---------------------------------------------------------------------------
// Schema, read at runtime so the script survives drift. Production is usually a
// deploy or two behind the repo (invoices.pay_token, for one), and a merge that
// hard-codes a column list would crash on the one column that is not there yet.
// ---------------------------------------------------------------------------
const schema = new Map()
const skipped = []

async function loadSchema() {
  const r = await db.query(
    `select table_name, column_name from information_schema.columns where table_schema = 'public'`,
  )
  for (const row of r.rows) {
    if (!schema.has(row.table_name)) schema.set(row.table_name, new Set())
    schema.get(row.table_name).add(row.column_name)
  }
}

const hasTable = (table) => schema.has(table)
const hasColumn = (table, column) => schema.get(table)?.has(column) === true

function note(message) {
  skipped.push(message)
  console.log(`  NOTE ${message}`)
}

function touchedTables() {
  return CHILD_TABLES.filter((t) => {
    if (!hasTable(t)) {
      note(`table ${t} does not exist in this database - skipped`)
      return false
    }
    if (!hasColumn(t, 'client_id')) {
      note(`${t}.client_id does not exist in this database - skipped`)
      return false
    }
    return true
  })
}

const stamped = (table) => (hasColumn(table, 'updated_at') ? ', updated_at = now()' : '')

async function countWhere(table, column, value) {
  const r = await db.query(`select count(*)::int as n from ${table} where ${column} = $1`, [value])
  return r.rows[0].n
}

async function idsWhere(table, column, value) {
  const r = await db.query(`select id from ${table} where ${column} = $1 order by id`, [value])
  return r.rows.map((row) => row.id)
}

const iso = (v) => (v instanceof Date ? v.toISOString() : v)

function invoiceFingerprint(row) {
  return JSON.stringify({
    id: row.id,
    number: row.number,
    status: row.status,
    total: row.total === null || row.total === undefined ? null : String(row.total),
    sent_at: iso(row.sent_at),
    due_date: iso(row.due_date),
  })
}

// ---------------------------------------------------------------------------
// Read everything the merge, the snapshot and the verification need.
// ---------------------------------------------------------------------------
async function gather(dupId, survId, tables) {
  const dupRow = (await db.query(`select * from clients where id = $1`, [dupId])).rows[0] ?? null
  const survRow = (await db.query(`select * from clients where id = $1`, [survId])).rows[0] ?? null

  const countsBefore = {}
  const moved = {}
  for (const t of tables) {
    countsBefore[t] = {
      duplicate: await countWhere(t, 'client_id', dupId),
      survivor: await countWhere(t, 'client_id', survId),
    }
    moved[t] = await idsWhere(t, 'client_id', dupId)
  }

  const onboarding = {}
  const onboardingCounts = {}
  for (const t of ONBOARDING_TABLES) {
    if (!hasColumn(t, 'onboarding_for_client_id')) {
      note(`${t}.onboarding_for_client_id does not exist in this database - skipped`)
      continue
    }
    onboarding[t] = await idsWhere(t, 'onboarding_for_client_id', dupId)
    onboardingCounts[t] = {
      duplicate: onboarding[t].length,
      survivor: await countWhere(t, 'onboarding_for_client_id', survId),
    }
  }

  const pointers = {}
  const pointerCounts = {}
  for (const c of CLIENT_POINTER_COLUMNS) {
    if (!hasColumn('clients', c)) {
      note(`clients.${c} does not exist in this database - skipped`)
      continue
    }
    pointers[c] = await idsWhere('clients', c, dupId)
    pointerCounts[c] = {
      duplicate: pointers[c].length,
      survivor: await countWhere('clients', c, survId),
    }
  }

  let groupRows = []
  if (hasColumn('time_entries', 'group_client_ids')) {
    groupRows = (
      await db.query(
        `select id, group_client_ids from time_entries where $1 = any(group_client_ids) order by id`,
        [dupId],
      )
    ).rows.map((r) => ({ id: r.id, before: r.group_client_ids }))
  } else {
    note('time_entries.group_client_ids does not exist in this database - skipped')
  }

  const jsonbColumns = ['line_items', 'original_line_items'].filter((c) => {
    if (hasColumn('invoices', c)) return true
    note(`invoices.${c} does not exist in this database - skipped`)
    return false
  })
  let invoiceJsonBefore = []
  if (jsonbColumns.length) {
    const predicate = jsonbColumns
      .map(
        (c) =>
          `(${c} is not null and ${c} @> jsonb_build_array(jsonb_build_object('sourceClientId', $1::text)))`,
      )
      .join(' or ')
    invoiceJsonBefore = (
      await db.query(
        `select id, ${jsonbColumns.join(', ')} from invoices where ${predicate} order by id`,
        [dupId],
      )
    ).rows
  }

  const assignmentRows = hasTable('client_assignments')
    ? (
        await db.query(
          `select client_id, user_id, assigned_at from client_assignments
            where client_id = any($1::text[]) order by client_id, user_id`,
          [[dupId, survId]],
        )
      ).rows
    : []
  const duplicateAssignments = assignmentRows
    .filter((r) => r.client_id === dupId)
    .map((r) => ({ userId: r.user_id, assignedAt: iso(r.assigned_at) }))
  const survivorAssignmentUserIdsBefore = assignmentRows
    .filter((r) => r.client_id === survId)
    .map((r) => r.user_id)
  if (!hasTable('client_assignments')) note('table client_assignments does not exist - skipped')

  const minutes = { duplicate: '0', survivor: '0' }
  if (tables.includes('time_entries') && hasColumn('time_entries', 'minutes')) {
    for (const [key, id] of [
      ['duplicate', dupId],
      ['survivor', survId],
    ]) {
      const r = await db.query(
        `select coalesce(sum(minutes), 0)::text as s from time_entries where client_id = $1`,
        [id],
      )
      minutes[key] = r.rows[0].s
    }
  }

  const survivorInvoices = tables.includes('invoices')
    ? (
        await db.query(
          `select id, number, status, total, sent_at, due_date from invoices where client_id = $1 order by id`,
          [survId],
        )
      ).rows.map(invoiceFingerprint)
    : []

  return {
    takenAt: new Date().toISOString(),
    duplicateId: dupId,
    survivorId: survId,
    duplicateRow: dupRow,
    survivorRow: survRow,
    countsBefore,
    moved,
    onboarding,
    onboardingCounts,
    pointers,
    pointerCounts,
    groupRows,
    jsonbColumns,
    invoiceJsonBefore,
    duplicateAssignments,
    survivorAssignmentUserIdsBefore,
    minutes,
    survivorInvoices,
  }
}

// ---------------------------------------------------------------------------
// Pre-checks. Everything here runs BEFORE the transaction and refuses loudly.
// ---------------------------------------------------------------------------
async function preChecks(before, dupId, survId) {
  const blockers = []
  const warnings = []

  if (dupId === survId) blockers.push('duplicateId and survivorId are the same id')
  if (!before.duplicateRow) blockers.push(`duplicate ${dupId} does not exist`)
  if (!before.survivorRow) blockers.push(`survivor ${survId} does not exist`)
  if (blockers.length) {
    return { blockers, warnings, nullSurvivorBillTo: false, nullSurvivorRecipient: false }
  }

  if (hasColumn('clients', 'stripe_customer_id') && before.duplicateRow.stripe_customer_id) {
    blockers.push(
      `duplicate has a Stripe customer (${before.duplicateRow.stripe_customer_id}) - resolve the Stripe side first`,
    )
  }
  if (hasColumn('clients', 'is_billing_master') && before.duplicateRow.is_billing_master) {
    blockers.push('duplicate is a billing master - other clients bill through it')
  }

  if (hasTable('invoices') && hasColumn('invoices', 'period')) {
    const kindClause = hasColumn('invoices', 'kind') ? `and d.kind = 'monthly' and s.kind = 'monthly'` : ''
    const r = await db.query(
      `select distinct d.period from invoices d
         join invoices s on s.period = d.period
        where d.client_id = $1 and s.client_id = $2
          and d.status <> 'void' and s.status <> 'void' ${kindClause}
        order by d.period`,
      [dupId, survId],
    )
    for (const row of r.rows) {
      blockers.push(`both clients have a live monthly invoice for ${row.period}`)
    }
  }

  if (hasTable('sales_tax_records')) {
    const r = await db.query(
      `select distinct d.period from sales_tax_records d
         join sales_tax_records s on s.period = d.period
        where d.client_id = $1 and s.client_id = $2 order by d.period`,
      [dupId, survId],
    )
    for (const row of r.rows) {
      blockers.push(`both clients have a sales tax record for ${row.period} (unique on client+period)`)
    }
  }

  if (hasColumn('time_entries', 'group_client_ids')) {
    const r = await db.query(
      `select id from time_entries where $1 = any(group_client_ids) and $2 = any(group_client_ids) order by id`,
      [dupId, survId],
    )
    for (const row of r.rows) {
      blockers.push(`time entry ${row.id} is split across BOTH clients - merging would lose a share`)
    }
  }

  let nullSurvivorBillTo = false
  let nullSurvivorRecipient = false
  if (hasColumn('clients', 'bill_to_client_id') && before.survivorRow.bill_to_client_id === dupId) {
    nullSurvivorBillTo = true
    warnings.push('survivor bills to the duplicate - that pointer is cleared instead of pointing at itself')
  }
  if (
    hasColumn('clients', 'invoice_recipient_client_id') &&
    before.survivorRow.invoice_recipient_client_id === dupId
  ) {
    nullSurvivorRecipient = true
    warnings.push(
      'survivor sends its invoices to the duplicate - that pointer is cleared instead of pointing at itself',
    )
  }

  if (hasTable('invoices')) {
    const r = await db.query(
      `select id, number, status from invoices
        where client_id = $1 and status in ('sent', 'processing', 'paid') order by id`,
      [dupId],
    )
    if (r.rows.length) {
      const list = r.rows.map((x) => `${x.number ?? x.id} (${x.status})`).join(', ')
      if (iKnow) warnings.push(`duplicate owns invoices the client has already seen: ${list} - --i-know given`)
      else blockers.push(`duplicate owns invoices the client has already seen: ${list} - pass --i-know to proceed`)
    }
  }

  return { blockers, warnings, nullSurvivorBillTo, nullSurvivorRecipient }
}

// ---------------------------------------------------------------------------
// Which of the duplicate's array ids cannot be validated and will be dropped.
// ---------------------------------------------------------------------------
async function unvalidatedArrayIds(before) {
  const dropped = {}
  for (const { column, validates } of ARRAY_UNIONS) {
    if (!hasColumn('clients', column)) {
      note(`clients.${column} does not exist in this database - skipped`)
      continue
    }
    if (!hasTable(validates)) {
      note(`table ${validates} does not exist - ${column} left alone`)
      continue
    }
    const dupValues = before.duplicateRow[column] ?? []
    const survValues = before.survivorRow[column] ?? []
    const candidates = dupValues.filter((e) => !survValues.includes(e))
    if (!candidates.length) {
      dropped[column] = []
      continue
    }
    const known = new Set(
      (await db.query(`select id from ${validates} where id = any($1::text[])`, [candidates])).rows.map(
        (r) => r.id,
      ),
    )
    dropped[column] = candidates.filter((e) => !known.has(e))
  }
  return dropped
}

async function freeTextHits(dupId) {
  const hits = []
  const needle = `%${dupId}%`
  for (const scan of FREE_TEXT_SCANS) {
    if (!hasTable(scan.table)) continue
    let where
    if (scan.wholeRow) {
      where = `to_jsonb(t.*)::text like $1`
    } else {
      const columns = scan.columns.filter((c) => hasColumn(scan.table, c))
      if (!columns.length) continue
      where = columns.map((c) => `coalesce(t.${c}::text, '') like $1`).join(' or ')
    }
    const r = await db.query(`select count(*)::int as n from ${scan.table} t where ${where}`, [needle])
    if (r.rows[0].n) hits.push({ table: scan.table, rows: r.rows[0].n })
  }
  return hits
}

// ---------------------------------------------------------------------------
// The merge itself.
// ---------------------------------------------------------------------------
async function repoint(before, dupId, survId, checks, tables) {
  const params = [dupId, survId]

  if (checks.nullSurvivorBillTo) {
    await db.query(`update clients set bill_to_client_id = null, updated_at = now() where id = $1`, [survId])
  }
  if (checks.nullSurvivorRecipient) {
    await db.query(`update clients set invoice_recipient_client_id = null, updated_at = now() where id = $1`, [
      survId,
    ])
  }

  const rowCounts = {}
  for (const t of tables) {
    const r = await db.query(
      `update ${t} set client_id = $2${stamped(t)} where client_id = $1`,
      params,
    )
    rowCounts[t] = r.rowCount
  }

  for (const t of Object.keys(before.onboarding)) {
    const r = await db.query(
      `update ${t} set onboarding_for_client_id = $2${stamped(t)} where onboarding_for_client_id = $1`,
      params,
    )
    rowCounts[`${t}.onboarding_for_client_id`] = r.rowCount
  }

  for (const c of Object.keys(before.pointers)) {
    const r = await db.query(
      `update clients set ${c} = $2, updated_at = now() where ${c} = $1`,
      params,
    )
    rowCounts[`clients.${c}`] = r.rowCount
  }

  if (hasColumn('time_entries', 'group_client_ids')) {
    const r = await db.query(
      `update time_entries
          set group_client_ids = (
                select coalesce(array_agg(distinct e), '{}'::text[])
                  from unnest(array_replace(group_client_ids, $1, $2)) e
              )${stamped('time_entries')}
        where $1 = any(group_client_ids)`,
      params,
    )
    rowCounts['time_entries.group_client_ids'] = r.rowCount
  }

  for (const c of before.jsonbColumns) {
    const nullGuard = c === 'line_items' ? '' : `${c} is not null and `
    const r = await db.query(
      `update invoices
          set ${c} = (
                select coalesce(
                         jsonb_agg(
                           case when el->>'sourceClientId' = $1
                                then jsonb_set(el, '{sourceClientId}', to_jsonb($2::text))
                                else el end
                         ),
                         '[]'::jsonb
                       )
                  from jsonb_array_elements(${c}) el
              )${stamped('invoices')}
        where ${nullGuard}${c} @> jsonb_build_array(jsonb_build_object('sourceClientId', $1::text))`,
      params,
    )
    rowCounts[`invoices.${c}`] = r.rowCount
  }

  if (hasTable('client_assignments')) {
    const inserted = await db.query(
      `insert into client_assignments (client_id, user_id, assigned_at)
       select $2, user_id, assigned_at from client_assignments where client_id = $1
       on conflict (client_id, user_id) do nothing`,
      params,
    )
    const deleted = await db.query(`delete from client_assignments where client_id = $1`, [dupId])
    rowCounts['client_assignments'] = `${inserted.rowCount} moved, ${deleted.rowCount} removed from duplicate`
  }

  return rowCounts
}

async function mergeClientRow(before, dupId, survId) {
  const assignments = []
  const values = [dupId, survId]

  for (const { column, validates } of ARRAY_UNIONS) {
    if (!hasColumn('clients', column) || !hasTable(validates)) continue
    assignments.push(
      `${column} = s.${column} || array(
          select e from unnest(d.${column}) e
           where not (e = any(s.${column}))
             and exists (select 1 from ${validates} p where p.id = e)
        )`,
    )
  }
  for (const c of TEXT_FILL_COLUMNS) {
    if (!hasColumn('clients', c)) {
      note(`clients.${c} does not exist in this database - not merged`)
      continue
    }
    assignments.push(`${c} = case when s.${c} is null or btrim(s.${c}) = '' then d.${c} else s.${c} end`)
  }
  for (const c of NUMERIC_FILL_COLUMNS) {
    if (!hasColumn('clients', c)) {
      note(`clients.${c} does not exist in this database - not merged`)
      continue
    }
    assignments.push(
      `${c} = case when (s.${c} is null or s.${c} = 0) and d.${c} is not null and d.${c} > 0 then d.${c} else s.${c} end`,
    )
  }
  assignments.push('updated_at = now()')

  const merged = await db.query(
    `update clients s set ${assignments.join(',\n        ')}
       from clients d where s.id = $2 and d.id = $1`,
    values,
  )

  const survivorName = before.survivorRow.name
  const marker = ` (merged into ${survivorName})`
  const dupName = before.duplicateRow.name ?? ''
  const retiredName = dupName.includes(marker) ? dupName : `${dupName}${marker}`
  const retireSets = [`name = $2`, `updated_at = now()`]
  const retireValues = [dupId, retiredName]
  if (hasColumn('clients', 'lifecycle_stage')) retireSets.push(`lifecycle_stage = 'inactive'`)
  else note('clients.lifecycle_stage does not exist - duplicate cannot be marked inactive')
  if (hasColumn('clients', 'assigned_bookkeeper_ids')) retireSets.push(`assigned_bookkeeper_ids = '{}'::text[]`)
  const retired = await db.query(
    `update clients set ${retireSets.join(', ')} where id = $1`,
    retireValues,
  )

  return { mergedRows: merged.rowCount, retiredRows: retired.rowCount, retiredName }
}

// ---------------------------------------------------------------------------
// In-transaction verification. Anything wrong here throws and rolls back.
// ---------------------------------------------------------------------------
async function verifyMerge(before, dupId, survId, tables, checks) {
  const problems = []

  for (const t of tables) {
    const dup = await countWhere(t, 'client_id', dupId)
    const surv = await countWhere(t, 'client_id', survId)
    const expected = before.countsBefore[t].duplicate + before.countsBefore[t].survivor
    if (dup !== 0) problems.push(`${t}: duplicate still has ${dup} rows`)
    if (surv !== expected) problems.push(`${t}: survivor has ${surv}, expected ${expected}`)
  }

  for (const [t, counts] of Object.entries(before.onboardingCounts)) {
    const dup = await countWhere(t, 'onboarding_for_client_id', dupId)
    const surv = await countWhere(t, 'onboarding_for_client_id', survId)
    if (dup !== 0) problems.push(`${t}.onboarding_for_client_id: duplicate still has ${dup} rows`)
    if (surv !== counts.duplicate + counts.survivor) {
      problems.push(
        `${t}.onboarding_for_client_id: survivor has ${surv}, expected ${counts.duplicate + counts.survivor}`,
      )
    }
  }

  for (const [c, counts] of Object.entries(before.pointerCounts)) {
    const dup = await countWhere('clients', c, dupId)
    const surv = await countWhere('clients', c, survId)
    if (dup !== 0) problems.push(`clients.${c}: ${dup} rows still point at the duplicate`)
    // The survivor's own pointer, when it named the duplicate, is cleared rather
    // than re-pointed at itself — so it does not arrive on the survivor's side.
    const cleared =
      (c === 'bill_to_client_id' && checks.nullSurvivorBillTo) ||
      (c === 'invoice_recipient_client_id' && checks.nullSurvivorRecipient)
        ? 1
        : 0
    const expected = counts.duplicate + counts.survivor - cleared
    if (surv !== expected) problems.push(`clients.${c}: survivor has ${surv}, expected ${expected}`)
  }

  if (hasColumn('time_entries', 'group_client_ids')) {
    const r = await db.query(
      `select count(*)::int as n from time_entries where $1 = any(group_client_ids)`,
      [dupId],
    )
    if (r.rows[0].n !== 0) problems.push(`time_entries.group_client_ids: ${r.rows[0].n} rows still name the duplicate`)
  }

  for (const c of before.jsonbColumns) {
    const r = await db.query(
      `select count(*)::int as n from invoices
        where ${c} is not null and ${c} @> jsonb_build_array(jsonb_build_object('sourceClientId', $1::text))`,
      [dupId],
    )
    if (r.rows[0].n !== 0) problems.push(`invoices.${c}: ${r.rows[0].n} rows still name the duplicate`)
  }

  if (hasTable('client_assignments')) {
    const dup = await countWhere('client_assignments', 'client_id', dupId)
    const surv = await countWhere('client_assignments', 'client_id', survId)
    const expected = new Set([
      ...before.survivorAssignmentUserIdsBefore,
      ...before.duplicateAssignments.map((a) => a.userId),
    ]).size
    if (dup !== 0) problems.push(`client_assignments: duplicate still has ${dup} rows`)
    if (surv !== expected) problems.push(`client_assignments: survivor has ${surv}, expected ${expected}`)
  }

  if (tables.includes('time_entries') && hasColumn('time_entries', 'minutes')) {
    const r = await db.query(
      `select coalesce(sum(minutes), 0)::text as s from time_entries where client_id = $1`,
      [survId],
    )
    const expected = Number(before.minutes.duplicate) + Number(before.minutes.survivor)
    if (Number(r.rows[0].s) !== expected) {
      problems.push(`time_entries minutes: survivor has ${r.rows[0].s}, expected ${expected}`)
    }
  }

  if (tables.includes('invoices')) {
    const after = new Map(
      (
        await db.query(
          `select id, number, status, total, sent_at, due_date from invoices where client_id = $1 order by id`,
          [survId],
        )
      ).rows.map((row) => [row.id, invoiceFingerprint(row)]),
    )
    for (const fingerprint of before.survivorInvoices) {
      const id = JSON.parse(fingerprint).id
      if (!after.has(id)) problems.push(`invoice ${id}: no longer on the survivor`)
      else if (after.get(id) !== fingerprint) {
        problems.push(`invoice ${id}: changed\n      before ${fingerprint}\n      after  ${after.get(id)}`)
      }
    }
  }

  if (problems.length) throw new Error(`verification failed:\n  - ${problems.join('\n  - ')}`)
}

// ---------------------------------------------------------------------------
async function forward() {
  if (!duplicateId || !survivorId) throw new Error(`two client ids are required.\n${USAGE}`)

  await loadSchema()
  if (!hasTable('clients')) throw new Error('no `clients` table here - this script is Postgres-only')

  console.log(`Merging ${duplicateId} INTO ${survivorId}`)
  const tables = touchedTables()
  const before = await gather(duplicateId, survivorId, tables)

  const checks = await preChecks(before, duplicateId, survivorId)
  console.log('\nPre-checks:')
  for (const w of checks.warnings) console.log(`  WARN  ${w}`)
  for (const b of checks.blockers) console.log(`  BLOCK ${b}`)
  if (!checks.blockers.length && !checks.warnings.length) console.log('  all clear')
  if (checks.blockers.length) throw new Error(`refusing to merge: ${checks.blockers.length} blocker(s) above`)

  console.log(
    `\nDuplicate: ${before.duplicateRow.name} (${duplicateId})\nSurvivor:  ${before.survivorRow.name} (${survivorId})`,
  )

  console.log('\nRows by table (duplicate + survivor -> survivor after):')
  for (const t of tables) {
    const c = before.countsBefore[t]
    console.log(`  ${t.padEnd(24)} ${String(c.duplicate).padStart(5)} + ${String(c.survivor).padStart(5)} -> ${c.duplicate + c.survivor}`)
  }
  for (const [t, c] of Object.entries(before.onboardingCounts)) {
    console.log(`  ${`${t}.onboarding`.padEnd(24)} ${String(c.duplicate).padStart(5)} + ${String(c.survivor).padStart(5)} -> ${c.duplicate + c.survivor}`)
  }
  for (const [c, counts] of Object.entries(before.pointerCounts)) {
    console.log(`  ${`clients.${c}`.padEnd(24)} ${String(counts.duplicate).padStart(5)} + ${String(counts.survivor).padStart(5)} -> ${counts.duplicate + counts.survivor}`)
  }
  console.log(`  ${'time_entries.group_ids'.padEnd(24)} ${String(before.groupRows.length).padStart(5)} rows rewritten`)
  console.log(`  ${'invoices jsonb source'.padEnd(24)} ${String(before.invoiceJsonBefore.length).padStart(5)} invoices rewritten`)
  console.log(
    `  ${'client_assignments'.padEnd(24)} ${String(before.duplicateAssignments.length).padStart(5)} + ${String(before.survivorAssignmentUserIdsBefore.length).padStart(5)} -> ${new Set([...before.survivorAssignmentUserIdsBefore, ...before.duplicateAssignments.map((a) => a.userId)]).size} (union)`,
  )
  console.log(
    `  ${'time_entries minutes'.padEnd(24)} ${before.minutes.duplicate} + ${before.minutes.survivor} -> ${Number(before.minutes.duplicate) + Number(before.minutes.survivor)}`,
  )

  if (before.moved.time_entries?.length) {
    console.log(`\nTime entries moved (${before.moved.time_entries.length}):`)
    for (const id of before.moved.time_entries) console.log(`  ${id}`)
  }
  for (const t of tables) {
    if (t === 'time_entries' || !before.moved[t].length) continue
    console.log(`${t} moved (${before.moved[t].length}): ${before.moved[t].join(', ')}`)
  }

  const dropped = await unvalidatedArrayIds(before)
  console.log('\nSurvivor arrays (order-preserving append, unvalidated ids dropped):')
  for (const { column } of ARRAY_UNIONS) {
    if (!(column in dropped)) continue
    const dup = before.duplicateRow[column] ?? []
    const surv = before.survivorRow[column] ?? []
    const added = dup.filter((e) => !surv.includes(e) && !dropped[column].includes(e))
    console.log(`  ${column}: ${JSON.stringify(surv)} + ${JSON.stringify(added)}`)
    if (dropped[column].length) console.log(`    DROPPED (unvalidated): ${dropped[column].join(', ')}`)
  }

  const hits = await freeTextHits(duplicateId)
  console.log('\nFree text naming the duplicate id (reported, NEVER rewritten):')
  if (!hits.length) console.log('  none')
  for (const h of hits) console.log(`  ${h.table}: ${h.rows} row(s)`)

  let snapshotPath = null
  if (apply) {
    const stamp = before.takenAt.replace(/[:.]/g, '-')
    snapshotPath = `docs/prod-snapshots/${stamp}-merge-${duplicateId}-into-${survivorId}.json`
    mkdirSync('docs/prod-snapshots', { recursive: true })
    writeFileSync(snapshotPath, JSON.stringify(before, null, 2) + '\n')
    console.log(`\nSnapshot written: ${snapshotPath}`)
  }

  await db.query('begin')
  const rowCounts = await repoint(before, duplicateId, survivorId, checks, tables)
  const clientResult = await mergeClientRow(before, duplicateId, survivorId)
  await verifyMerge(before, duplicateId, survivorId, tables, checks)

  console.log('\nStatements:')
  for (const [key, n] of Object.entries(rowCounts)) console.log(`  ${key.padEnd(34)} ${n}`)
  console.log(`  ${'clients (survivor merged)'.padEnd(34)} ${clientResult.mergedRows}`)
  console.log(`  ${'clients (duplicate retired)'.padEnd(34)} ${clientResult.retiredRows} -> "${clientResult.retiredName}", inactive`)

  if (apply) {
    await db.query('commit')
    console.log(`\nAPPLIED. Verification passed. Undo: --undo ${snapshotPath} --apply`)
  } else {
    await db.query('rollback')
    console.log('\nDRY RUN: verification passed against the uncommitted result. ROLLED BACK. Nothing was written.')
  }
}

// ---------------------------------------------------------------------------
async function undo() {
  const snap = JSON.parse(readFileSync(undoPath, 'utf8'))
  const dupId = snap.duplicateId
  const survId = snap.survivorId
  await loadSchema()
  console.log(`Undoing the merge of ${dupId} into ${survId} from ${undoPath} (taken ${snap.takenAt})`)

  await db.query('begin')

  for (const [t, ids] of Object.entries(snap.moved)) {
    if (!ids.length) continue
    if (!hasColumn(t, 'client_id')) {
      note(`${t}.client_id no longer exists - ${ids.length} row(s) NOT restored`)
      continue
    }
    const r = await db.query(
      `update ${t} set client_id = $1${stamped(t)} where id = any($2::text[])`,
      [dupId, ids],
    )
    console.log(`  ${t}: ${r.rowCount} row(s) back to the duplicate`)
  }

  for (const [t, ids] of Object.entries(snap.onboarding ?? {})) {
    if (!ids.length || !hasColumn(t, 'onboarding_for_client_id')) continue
    const r = await db.query(
      `update ${t} set onboarding_for_client_id = $1${stamped(t)} where id = any($2::text[])`,
      [dupId, ids],
    )
    console.log(`  ${t}.onboarding_for_client_id: ${r.rowCount} row(s) restored`)
  }

  for (const [c, ids] of Object.entries(snap.pointers ?? {})) {
    if (!ids.length || !hasColumn('clients', c)) continue
    const r = await db.query(
      `update clients set ${c} = $1, updated_at = now() where id = any($2::text[])`,
      [dupId, ids],
    )
    console.log(`  clients.${c}: ${r.rowCount} row(s) restored`)
  }

  for (const row of snap.groupRows ?? []) {
    await db.query(
      `update time_entries set group_client_ids = $2::text[]${stamped('time_entries')} where id = $1`,
      [row.id, row.before],
    )
  }
  if (snap.groupRows?.length) console.log(`  time_entries.group_client_ids: ${snap.groupRows.length} row(s) restored`)

  for (const row of snap.invoiceJsonBefore ?? []) {
    const columns = (snap.jsonbColumns ?? []).filter((c) => hasColumn('invoices', c))
    if (!columns.length) continue
    const sets = columns.map((c, i) => `${c} = $${i + 2}::jsonb`)
    const values = [row.id, ...columns.map((c) => (row[c] === null || row[c] === undefined ? null : JSON.stringify(row[c])))]
    await db.query(`update invoices set ${sets.join(', ')}${stamped('invoices')} where id = $1`, values)
  }
  if (snap.invoiceJsonBefore?.length) {
    console.log(`  invoices line item sources: ${snap.invoiceJsonBefore.length} invoice(s) restored`)
  }

  if (hasTable('client_assignments')) {
    for (const a of snap.duplicateAssignments ?? []) {
      await db.query(
        `insert into client_assignments (client_id, user_id, assigned_at) values ($1, $2, $3)
         on conflict (client_id, user_id) do nothing`,
        [dupId, a.userId, a.assignedAt],
      )
    }
    const survivorBefore = new Set(snap.survivorAssignmentUserIdsBefore ?? [])
    const toRemove = (snap.duplicateAssignments ?? [])
      .map((a) => a.userId)
      .filter((u) => !survivorBefore.has(u))
    if (toRemove.length) {
      await db.query(`delete from client_assignments where client_id = $1 and user_id = any($2::text[])`, [
        survId,
        toRemove,
      ])
    }
    console.log(
      `  client_assignments: ${(snap.duplicateAssignments ?? []).length} restored to the duplicate, ${toRemove.length} removed from the survivor`,
    )
  }

  for (const [label, row] of [
    ['duplicate', snap.duplicateRow],
    ['survivor', snap.survivorRow],
  ]) {
    if (!row) continue
    const columns = Object.keys(row).filter((c) => c !== 'id' && hasColumn('clients', c))
    const sets = columns.map((c, i) => `${c} = $${i + 2}`)
    const values = [row.id, ...columns.map((c) => row[c])]
    const r = await db.query(`update clients set ${sets.join(', ')} where id = $1`, values)
    console.log(`  clients (${label} ${row.id}): ${r.rowCount} row restored across ${columns.length} column(s)`)
  }

  const problems = []
  for (const [t, counts] of Object.entries(snap.countsBefore ?? {})) {
    if (!hasColumn(t, 'client_id')) continue
    const dup = await countWhere(t, 'client_id', dupId)
    const surv = await countWhere(t, 'client_id', survId)
    if (dup !== counts.duplicate) problems.push(`${t}: duplicate has ${dup}, snapshot says ${counts.duplicate}`)
    if (surv !== counts.survivor) problems.push(`${t}: survivor has ${surv}, snapshot says ${counts.survivor}`)
  }
  if (problems.length) throw new Error(`undo verification failed:\n  - ${problems.join('\n  - ')}`)

  if (apply) {
    await db.query('commit')
    console.log('\nRESTORED. Verification passed against the snapshot counts.')
  } else {
    await db.query('rollback')
    console.log('\nDRY RUN: the restore verified against the snapshot counts. ROLLED BACK. Nothing was written.')
  }
}

async function main() {
  await db.connect()
  try {
    if (undoPath) await undo()
    else await forward()
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error(`ERR ${error.message}`)
  process.exit(1)
})
