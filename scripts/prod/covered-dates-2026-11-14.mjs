#!/usr/bin/env node
/**
 * ONE-TIME production write, approved by Alex on 2026-11-14 ("yes run the
 * re-stamp and fix the three"), after the covered-dates ship (433f75e1,
 * featreq-6678d532).
 *
 * Two things, in one short transaction:
 *
 *   1. Three repeating tasks whose typed covered dates were plainly off are set
 *      so their open checklist reads October 1 - October 31, 2026, anchored to
 *      that open checklist (exactly what typing the two dates on the repeating
 *      task now does):
 *        - Conch Shack Investments / Monthly Reconciliations (dates typed a
 *          month ahead of the checklist they were set for),
 *        - Emerald Custom Homes / Monthly Reconciliations (no anchor at all, so
 *          it read August forever),
 *        - Cooper & Cooper, PA / Monthly Reconciliations with Review (a month
 *          behind).
 *   2. The re-stamp the app runs on every bulk save, run now instead of waiting
 *      for the first save: the stored covered dates of the OPEN checklists are
 *      rewritten to what the new rules give. Decided by the app's own planner
 *      (`periodRestampPlan`), never by this script.
 *
 * The plan is worked out READ-ONLY first. The write then touches only the rows
 * the plan names, each guarded by the value it was planned against (a label
 * that changed in between, or was set by hand, is left alone and the whole
 * write is rolled back for a fresh look). Nothing is deleted.
 *
 *   node scripts/prod/covered-dates-2026-11-14.mjs            dry run
 *   node scripts/prod/covered-dates-2026-11-14.mjs --apply    write, after a snapshot
 *
 * The snapshot (docs/prod-snapshots/2026-11-14-covered-dates.json) holds every
 * before-value, which is the undo.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { prodDatabaseUrl, prodEnv } from './env.mjs'
import { caseOccurrenceKey, caseOccurrences } from '../../lib/checklist-period-label.js'

const apply = process.argv.includes('--apply')
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const snapshotPath = path.join(repoRoot, 'docs', 'prod-snapshots', '2026-11-14-covered-dates.json')

const url = prodDatabaseUrl(prodEnv(['PROD_DATABASE_URL']).PROD_DATABASE_URL)
// The store must not open its own pool: it is imported only for its planner.
delete process.env.DATABASE_URL
const { periodRestampPlan } = await import('../../db/store.js')

const FIXES = [
  { client: 'Conch Shack Investments', title: 'Monthly Reconciliations' },
  { client: 'Emerald Custom Homes', title: 'Monthly Reconciliations' },
  { client: 'Cooper & Cooper, PA', title: 'Monthly Reconciliations with Review' },
]
const WINDOW = { start: '2026-10-01', end: '2026-10-31' }

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: true } })
await client.connect()
const q = (text, params) => client.query(text, params)

/** The store's rule: finished = has steps and every one is done (sub-steps decide a parent). */
function finished(items) {
  if (!items || items.length === 0) return false
  return items.every((item) => {
    const subs = Array.isArray(item.sub_items) ? item.sub_items : []
    return subs.length > 0 ? subs.every((sub) => sub && sub.done === true) : item.done === true
  })
}

async function instancesOf(templateId) {
  const lists = await q(
    `select id, case_id, client_id, stage_index, period_label, period_label_manual,
            skipped_at is not null as skipped,
            to_char(due_date, 'YYYY-MM-DD') as due_date,
            to_char(cycle_due_date, 'YYYY-MM-DD') as cycle_due_date,
            deleted_at is not null as deleted
       from checklists where template_id = $1`,
    [templateId],
  )
  const live = lists.rows.filter((row) => !row.deleted)
  const items = live.length
    ? await q(
        `select checklist_id, done, sub_items from checklist_items where checklist_id = any($1::text[])`,
        [live.map((row) => row.id)],
      )
    : { rows: [] }
  const byList = new Map()
  for (const item of items.rows) {
    const list = byList.get(item.checklist_id) ?? []
    list.push(item)
    byList.set(item.checklist_id, list)
  }
  return lists.rows.map((row) => ({
    id: row.id,
    caseId: row.case_id || row.id,
    clientId: row.client_id,
    stageIndex: row.stage_index,
    dueDate: row.due_date,
    cycleDueDate: row.cycle_due_date,
    periodLabel: row.period_label,
    periodLabelManual: row.period_label_manual === true,
    deleted: row.deleted === true,
    skipped: row.skipped === true,
    completed: finished(byList.get(row.id)),
  }))
}

try {
  // ---------------------------------------------------------------- plan (read-only)
  await q('begin read only')
  await q("set local statement_timeout = '60s'")
  const recipes = await q(
    `select t.id, t.title, t.frequency, t.scheduled_months, t.period_label_enabled,
            (select name from clients c where c.id = t.client_id) as client,
            to_char(t.period_coverage_start, 'YYYY-MM-DD') as s,
            to_char(t.period_coverage_end, 'YYYY-MM-DD') as e,
            to_char(t.period_coverage_anchor_due, 'YYYY-MM-DD') as a
       from checklist_templates t
      where t.period_label_enabled = true or t.period_coverage_start is not null
         or t.period_coverage_end is not null or t.period_coverage_anchor_due is not null`,
  )

  const templateFixes = []
  for (const fix of FIXES) {
    const matches = recipes.rows.filter(
      (row) => row.client === fix.client && row.title === fix.title && row.period_label_enabled,
    )
    if (matches.length !== 1) throw new Error(`expected one recipe for ${fix.client} / ${fix.title}, found ${matches.length}`)
    const row = matches[0]
    const instances = await instancesOf(row.id)
    const occurrences = caseOccurrences(instances)
    const open = [
      ...new Set(
        instances
          .filter((i) => !i.deleted && !i.skipped && !i.completed && !i.periodLabelManual)
          .map((i) => occurrences.get(caseOccurrenceKey(i))),
      ),
    ].sort()
    // The dates are set for the earliest open checklist, and "October" is only
    // right if that checklist began in November.
    if (open.length === 0 || open[0].slice(0, 7) !== '2026-11') {
      throw new Error(`${fix.client}: the earliest open checklist began ${open[0] ?? 'never'}, not in November 2026 - stopping`)
    }
    templateFixes.push({
      id: row.id,
      client: row.client,
      title: row.title,
      before: { start: row.s, end: row.e, anchor: row.a },
      after: { start: WINDOW.start, end: WINDOW.end, anchor: open[0] },
    })
    // The plan below is worked out against the corrected recipe.
    row.s = WINDOW.start
    row.e = WINDOW.end
    row.a = open[0]
  }

  const labelChanges = []
  for (const row of recipes.rows) {
    const template = {
      frequency: row.frequency,
      periodLabelEnabled: Boolean(row.period_label_enabled),
      scheduledMonths: Array.isArray(row.scheduled_months) ? row.scheduled_months : [],
      periodCoverageStart: row.s,
      periodCoverageEnd: row.e,
      periodCoverageAnchorDue: row.a,
    }
    const instances = await instancesOf(row.id)
    for (const entry of periodRestampPlan(template, instances)) {
      labelChanges.push({ id: entry.id, templateId: row.id, client: row.client, title: row.title, before: entry.before, after: entry.after })
    }
  }
  await q('rollback')

  console.log(`recipes carrying covered dates: ${recipes.rows.length}`)
  console.log('\nrecipe corrections:')
  for (const fix of templateFixes) {
    console.log(`  ${fix.client} / ${fix.title}: ${fix.before.start}..${fix.before.end} set for ${fix.before.anchor} -> ${fix.after.start}..${fix.after.end} set for ${fix.after.anchor}`)
  }
  console.log(`\nchecklist labels to rewrite: ${labelChanges.length}`)
  const tally = new Map()
  for (const change of labelChanges) {
    const key = `"${change.before ?? ''}" -> "${change.after ?? ''}"`
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
  for (const [key, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${n} x ${key}`)
  for (const fix of templateFixes) {
    for (const change of labelChanges.filter((c) => c.templateId === fix.id)) {
      console.log(`  (${fix.client}: "${change.before ?? ''}" -> "${change.after ?? ''}")`)
    }
  }

  if (!apply) {
    console.log('\nDRY RUN - nothing written. Re-run with --apply to write.')
  } else {
    // ---------------------------------------------------------------- write
    writeFileSync(
      snapshotPath,
      `${JSON.stringify(
        {
          what: 'Covered dates: three recipe corrections and the first re-stamp after 433f75e1 (featreq-6678d532). Approved by Alex 2026-11-14.',
          takenAt: new Date().toISOString(),
          undo: 'Set each recipe back to `before` (period_coverage_start, period_coverage_end, period_coverage_anchor_due) and each checklist period_label back to `before`. Note the app re-stamps open labels from the recipe on every bulk save.',
          templates: templateFixes,
          checklists: labelChanges.map(({ id, templateId, before, after }) => ({ id, templateId, before, after })),
        },
        null,
        2,
      )}\n`,
    )
    console.log(`\nsnapshot written: ${snapshotPath}`)

    await q('begin')
    await q("set local lock_timeout = '3s'")
    await q("set local statement_timeout = '30s'")
    let wrote = 0
    for (const fix of templateFixes) {
      const result = await q(
        `update checklist_templates
            set period_coverage_start = $2::date, period_coverage_end = $3::date,
                period_coverage_anchor_due = $4::date, updated_at = now()
          where id = $1
            and period_coverage_start is not distinct from $5::date
            and period_coverage_end is not distinct from $6::date
            and period_coverage_anchor_due is not distinct from $7::date`,
        [fix.id, fix.after.start, fix.after.end, fix.after.anchor, fix.before.start, fix.before.end, fix.before.anchor],
      )
      wrote += result.rowCount
    }
    if (wrote !== templateFixes.length) {
      await q('rollback')
      throw new Error(`recipe rows changed underneath the plan (${wrote} of ${templateFixes.length}) - rolled back, nothing written`)
    }
    let relabeled = 0
    for (const change of labelChanges) {
      const result = await q(
        `update checklists set period_label = $2, updated_at = now()
          where id = $1 and period_label_manual = false and deleted_at is null
            and period_label is not distinct from $3`,
        [change.id, change.after, change.before],
      )
      relabeled += result.rowCount
    }
    if (relabeled !== labelChanges.length) {
      await q('rollback')
      throw new Error(`checklist rows changed underneath the plan (${relabeled} of ${labelChanges.length}) - rolled back, nothing written`)
    }
    await q('commit')
    console.log(`WRITTEN: ${wrote} recipes corrected, ${relabeled} checklist labels rewritten.`)

    // ---------------------------------------------------------------- verify
    await q('begin read only')
    let left = 0
    for (const row of recipes.rows) {
      const fresh = (
        await q(
          `select frequency, scheduled_months, period_label_enabled,
                  to_char(period_coverage_start, 'YYYY-MM-DD') as s,
                  to_char(period_coverage_end, 'YYYY-MM-DD') as e,
                  to_char(period_coverage_anchor_due, 'YYYY-MM-DD') as a
             from checklist_templates where id = $1`,
          [row.id],
        )
      ).rows[0]
      left += periodRestampPlan(
        {
          frequency: fresh.frequency,
          periodLabelEnabled: Boolean(fresh.period_label_enabled),
          scheduledMonths: Array.isArray(fresh.scheduled_months) ? fresh.scheduled_months : [],
          periodCoverageStart: fresh.s,
          periodCoverageEnd: fresh.e,
          periodCoverageAnchorDue: fresh.a,
        },
        await instancesOf(row.id),
      ).length
    }
    await q('rollback')
    console.log(`verified: the app's own re-stamp would now rewrite ${left} labels (0 = nothing left for the first save to do).`)
  }
} catch (error) {
  await q('rollback').catch(() => {})
  console.error(error.message)
  process.exitCode = 1
} finally {
  await client.end()
}
