#!/usr/bin/env node
// One approved production write (Alex, 2026-10-17, tracker featreq-ed73d181): the
// I-95 Signature, LLC "Quarterly Reconciliations with Review" case for July-September
// (case-8b17c9df) finished step 1 of 6 on 2026-10-07 and its step 2 was never
// created - the same silent pre-hardening stall as Bright Tower / XAct (HANDOFF,
// 2026-10-12 17:15Z paragraph). As on 10-12, ONE step of the stage-1 row
// (check-928df429, item-3efe0a4f "TD Bank 7765") is unticked and re-ticked through
// `store.toggleChecklistItem`, so `maybeSpawnNextStage` runs with its normal rules
// and its `[stage-advance]` logging. Acting as emp-alex-anderson; the Activity rows
// the toggle route writes are written the same way. case-274ce3c4 (September
// Monthly Reconciliations, also stalled) is deliberately left alone.
//
//   node scripts/prod/i95-respawn-2026-10-17.mjs            # dry run: snapshot + plan
//   node scripts/prod/i95-respawn-2026-10-17.mjs --apply    # do it
//
// Connection: DATABASE_PUBLIC_URL or DATABASE_URL, else `railway variables` for the
// Postgres service (the project must be linked). The store is built the way the
// server builds it; PGSSLMODE=no-verify is set here because the Railway public
// proxy presents a certificate node-pg will not verify. The dry run reads with
// plain SELECTs only (never `store.read()`, which can write back).
//
// NOT done by this script (the route does them): the SSE broadcast and the
// task_assigned notification/email to the step-2 assignee (Lisa).
//
// Undo (snapshot: docs/prod-snapshots/2026-10-17-i95-respawn.json):
//   1. delete from checklists where case_id = 'case-8b17c9df' and stage_index = 1;
//      Its items go with it: checklist_items.checklist_id references checklists(id)
//      ON DELETE CASCADE (db/schema.sql:172; the dry run re-checks the live FK).
//   2. update checklist_items set done = <snapshot done>, completed_at = <snapshot completed_at>
//        where checklist_id = 'check-928df429' and id = 'item-3efe0a4f';
//      (the re-tick stamps completed_at = now; the snapshot holds 2026-10-07T20:20:30.044Z).

import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Pool } = require('pg')

const ACTOR = 'emp-alex-anderson'
const CLIENT_ID = 'client-8c96151c'
const CASE_ID = 'case-8b17c9df'
const CHECKLIST_ID = 'check-928df429'
const ITEM_ID = 'item-3efe0a4f'
const SNAPSHOT_PATH = 'docs/prod-snapshots/2026-10-17-i95-respawn.json'

const apply = process.argv.includes('--apply')

function connectionString() {
  if (process.env.DATABASE_PUBLIC_URL) return process.env.DATABASE_PUBLIC_URL
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  const raw = execSync('npx @railway/cli@latest variables --service Postgres --json', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return JSON.parse(raw).DATABASE_PUBLIC_URL
}

const url = connectionString()
if (!url) {
  console.error('DATABASE_PUBLIC_URL (or DATABASE_URL, or a linked Railway project) is required')
  process.exit(1)
}
process.env.DATABASE_URL = url
process.env.PGSSLMODE = 'no-verify'

const { AppDataStore } = await import('../../db/store.js')
const store = new AppDataStore()
if (store.mode !== 'postgres') throw new Error('store did not come up in postgres mode')
const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 })

const iso = (value) => (value instanceof Date ? value.toISOString() : value ?? null)
const day = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value ?? null)

async function caseRows() {
  const rows = (
    await pool.query(
      `select id, title, client_id, assignee_id, template_id, stage_id, stage_index, stage_count,
              due_date, category_id, deleted_at, skipped_at, pushed_to_checklist_id, period_label, created_at
         from checklists where case_id = $1 order by stage_index, created_at`,
      [CASE_ID],
    )
  ).rows
  for (const row of rows) {
    row.items = (
      await pool.query(
        `select id, label, done, completed_at, assignee_id, waiting, waiting_on, waiting_ons
           from checklist_items where checklist_id = $1 order by sort_order`,
        [row.id],
      )
    ).rows
  }
  return rows
}

function printCase(rows) {
  for (const row of rows) {
    console.log(
      `  ${row.id} stage ${row.stage_index + 1} of ${row.stage_count} | ${row.title.trim()} | assignee ${row.assignee_id} | due ${day(row.due_date)} | stage ${row.stage_id}${row.deleted_at ? ' | DELETED' : ''}${row.skipped_at ? ' | SKIPPED' : ''}`,
    )
    for (const item of row.items) {
      console.log(`      [${item.done ? 'x' : ' '}] ${item.id} ${item.label} | completed_at ${iso(item.completed_at)}`)
    }
  }
}

try {
  // --- preconditions, read with plain SELECTs ---
  const before = await caseRows()
  const stage1 = before.find((row) => row.id === CHECKLIST_ID)
  if (!stage1) throw new Error(`${CHECKLIST_ID} not found in ${CASE_ID}`)
  if (stage1.client_id !== CLIENT_ID) throw new Error(`${CHECKLIST_ID} is not on ${CLIENT_ID}`)
  if (stage1.stage_index !== 0 || stage1.stage_count !== 6) {
    throw new Error(`${CHECKLIST_ID} is stage_index ${stage1.stage_index} of ${stage1.stage_count}, expected 0 of 6`)
  }
  if (stage1.deleted_at || stage1.skipped_at || stage1.pushed_to_checklist_id) {
    throw new Error(`${CHECKLIST_ID} is deleted, skipped or pushed`)
  }
  const item = stage1.items.find((entry) => entry.id === ITEM_ID)
  if (!item) throw new Error(`${ITEM_ID} not on ${CHECKLIST_ID}`)
  if (!stage1.items.every((entry) => entry.done)) throw new Error('stage 1 is not all done - nothing to re-tick')
  if (item.waiting || item.waiting_on || (Array.isArray(item.waiting_ons) && item.waiting_ons.length > 0)) {
    throw new Error(`${ITEM_ID} carries a wait - stop and look`)
  }
  const stage2Existing = before.filter((row) => row.stage_index === 1)
  if (stage2Existing.length > 0) {
    throw new Error(`a stage_index=1 row already exists for ${CASE_ID}: ${stage2Existing.map((r) => r.id).join(', ')}`)
  }
  const template = (
    await pool.query(`select id, title, active from checklist_templates where id = $1`, [stage1.template_id])
  ).rows[0]
  if (!template) throw new Error(`template ${stage1.template_id} not found`)
  const nextStage = (
    await pool.query(
      `select s.id, s.name, s.assignee_id, s.offset_days, s.due_date, s.category_id,
              (select count(*)::int from checklist_template_items i where i.stage_id = s.id) as items
         from checklist_template_stages s where s.template_id = $1 order by s.position offset 1 limit 1`,
      [stage1.template_id],
    )
  ).rows[0]
  if (!nextStage || nextStage.items === 0) throw new Error('the recipe has no non-empty stage 2 - the advance would skip')
  const collide = (
    await pool.query(
      `select id from checklists where template_id = $1 and stage_index = 1 and deleted_at is null`,
      [stage1.template_id],
    )
  ).rows
  const fk = (
    await pool.query(
      `select conname, confdeltype from pg_constraint
        where conrelid = 'checklist_items'::regclass and confrelid = 'checklists'::regclass and contype = 'f'`,
    )
  ).rows
  const cascade = fk.length > 0 && fk.every((row) => row.confdeltype === 'c')

  console.log(`case ${CASE_ID} now (I-95 Signature, LLC):`)
  printCase(before)
  console.log(`no stage_index=1 row for ${CASE_ID}: yes`)
  console.log(
    `recipe ${template.id} "${template.title.trim()}" active=${template.active} (the advance does not read 'active')`,
  )
  console.log(
    `stage 2 on the recipe: ${nextStage.id} "${nextStage.name}" assignee ${nextStage.assignee_id} offset ${nextStage.offset_days} due ${day(nextStage.due_date)} column ${nextStage.category_id} items ${nextStage.items}`,
  )
  console.log(`other rows of this recipe at stage_index 1 (unique-index collisions): ${collide.length}`)
  console.log(
    `checklist_items -> checklists FK: ${fk.map((row) => `${row.conname} on delete ${row.confdeltype === 'c' ? 'CASCADE' : row.confdeltype}`).join(', ')}`,
  )
  if (!cascade) throw new Error('checklist_items FK is not ON DELETE CASCADE - the undo would need an explicit item delete')

  mkdirSync('docs/prod-snapshots', { recursive: true })
  const snapshot = {
    at: new Date().toISOString(),
    reason: 'featreq-ed73d181: I-95 Quarterly Reconciliations with Review step 2 never spawned; re-tick via store.toggleChecklistItem',
    actor: ACTOR,
    caseId: CASE_ID,
    before: {
      [CHECKLIST_ID]: stage1.items.map((entry) => ({
        id: entry.id,
        label: entry.label,
        done: entry.done,
        completed_at: iso(entry.completed_at),
      })),
      stageIndex1RowsForCase: [],
    },
    undo: [
      `delete from checklists where case_id = '${CASE_ID}' and stage_index = 1; -- items cascade (checklist_items_checklist_id FK on delete cascade)`,
      `update checklist_items set done = ${item.done}, completed_at = '${iso(item.completed_at)}' where checklist_id = '${CHECKLIST_ID}' and id = '${ITEM_ID}';`,
    ],
  }
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n')
  console.log('snapshot', SNAPSHOT_PATH)

  console.log(
    `plan: as ${ACTOR}, store.toggleChecklistItem(${CHECKLIST_ID}, ${ITEM_ID}) twice (untick, re-tick); the re-tick runs maybeSpawnNextStage -> expect stage 2 "${nextStage.name}" for ${nextStage.assignee_id}`,
  )

  if (!apply) {
    console.log('DRY RUN - nothing written to the database (pass --apply)')
  } else {
    const options = { closeWaitsBy: ACTOR } // what the route passes for an owner; there are no waits here
    const untick = await store.toggleChecklistItem(CHECKLIST_ID, ITEM_ID, undefined, undefined, options)
    if (!untick?.checklist) throw new Error('untick returned nothing - item not found')
    const unticked = untick.checklist.items.find((entry) => entry.id === ITEM_ID)
    if (unticked?.done) throw new Error('untick left the item done - stopping before the re-tick')
    await store.recordActivity(ACTOR, 'checklist_item_unchecked', `${untick.checklist.title}: ${unticked?.label ?? ''}`.trim())
    console.log(`unticked ${ITEM_ID} (spawnReason ${untick.spawnReason ?? 'null'})`)

    const retick = await store.toggleChecklistItem(CHECKLIST_ID, ITEM_ID, undefined, undefined, options)
    if (!retick?.checklist) throw new Error('re-tick returned nothing - item not found; the item is now UNTICKED')
    const reticked = retick.checklist.items.find((entry) => entry.id === ITEM_ID)
    await store.recordActivity(ACTOR, 'checklist_item_checked', `${retick.checklist.title}: ${reticked?.label ?? ''}`.trim())
    const where = `${retick.checklist.title} · case ${CASE_ID} · stage 1 -> stage 2`
    if (retick.spawned) {
      await store.recordActivity(ACTOR, 'case_advanced', where)
      console.log(`re-ticked ${ITEM_ID}; spawned ${retick.spawned.id}`)
    } else if (retick.spawnError) {
      await store.recordActivity(ACTOR, 'case_advance_failed', `${where}: ${retick.spawnError}`)
      console.log(`re-ticked ${ITEM_ID}; spawn FAILED: ${retick.spawnError}`)
      process.exitCode = 1
    } else {
      await store.recordActivity(ACTOR, 'case_advance_skipped', `${where}: ${retick.spawnReason}`)
      console.log(`re-ticked ${ITEM_ID}; NOT advanced: ${retick.spawnReason}`)
      process.exitCode = 1
    }

    console.log(`case ${CASE_ID} after:`)
    const after = await caseRows()
    printCase(after)
    const stage2 = after.filter((row) => row.stage_index === 1 && !row.deleted_at)
    console.log(
      stage2.length === 1
        ? `NEW STAGE 2: ${stage2[0].id} assignee ${stage2[0].assignee_id} due ${day(stage2[0].due_date)} items ${stage2[0].items.length}`
        : `stage_index=1 rows after: ${stage2.length}`,
    )
    console.log('COMMITTED')
  }
} catch (error) {
  console.error('FAILED', error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error)
  process.exitCode = 1
} finally {
  await pool.end()
  if (store.pool) await store.pool.end()
}
