#!/usr/bin/env node
/**
 * featreq-053fccba: re-anchor the specific-months recipes whose period window was
 * anchored to a ghost `nextDueDate`, and restamp the checklist labels that were
 * computed from it.
 *
 * Why a script at all: `period_label` is stamped at spawn (db/store.js,
 * `buildChecklistFromStage`) and then STORED, and `period_coverage_anchor_due`
 * was written by the old SPA from `nextDueDate` — a date a specific-months
 * recipe never runs on. Fixing the math fixes what spawns from now on; the rows
 * already written keep the wrong words until something rewrites them.
 *
 * WHAT IT CHANGES, in order:
 *   (a) `checklist_templates.period_coverage_anchor_due` for every
 *       specific-months recipe with the label switched on whose anchor is not
 *       the 1st of one of its own designated months. The new anchor is what the
 *       SPA's `coverageAnchorForTemplate` would have produced on the day the
 *       window was set — the template's `updated_at` date (UTC), falling back to
 *       the anchor's own date. Same function the app uses, imported, not copied.
 *   (b) `checklists.period_label`, recomputed from the template WITH the
 *       corrected anchor, and written only where a label is already stored and
 *       differs. A row with no label is left alone: those spawned before the
 *       feature existed and the feature stamps "every occurrence from now on".
 *
 * Modes (connection: DATABASE_PUBLIC_URL on stdin as the Railway variables JSON,
 * never printed):
 *   npx @railway/cli@latest variables --service Postgres --json \
 *     | node scripts/prod/fix-period-labels.mjs                   dry run, ROLLBACK
 *     | node scripts/prod/fix-period-labels.mjs --apply           writes
 *     | node scripts/prod/fix-period-labels.mjs --undo <snapshot> puts it back
 *
 * Every mode writes/reads a snapshot of every row it touches — templates AND
 * checklists, each with its before and its after — to docs/prod-snapshots/ BEFORE
 * any write. `--undo` refuses outright if any touched row no longer holds the
 * value this script wrote, because that means somebody has been in there since
 * and an undo would throw their work away.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

import {
  coverageAnchorForTemplate,
  periodLabelForInstance,
} from '../../lib/checklist-period-label.js'

const require = createRequire(import.meta.url)
const { Client } = require('pg')

const apply = process.argv.includes('--apply')
const undoAt = process.argv.indexOf('--undo')
const undoPath = undoAt >= 0 ? process.argv[undoAt + 1] : null
if (undoAt >= 0 && !undoPath) {
  console.error('usage: fix-period-labels.mjs --undo <snapshot.json> [--apply]')
  process.exit(1)
}

const vars = JSON.parse(readFileSync(0, 'utf8'))
if (!vars.DATABASE_PUBLIC_URL) {
  console.error('DATABASE_PUBLIC_URL missing from stdin JSON')
  process.exit(1)
}

const db = new Client({
  connectionString: vars.DATABASE_PUBLIC_URL,
  ssl: { rejectUnauthorized: false },
})

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const show = (value) => (value === null || value === undefined ? '(none)' : value)

/**
 * Refuse to touch production with the OLD math.
 *
 * This script's whole justification is that `lib/checklist-period-label.js` now
 * steps a whole-month window by months and counts specific-months recipes in
 * occurrences. Run against the pre-fix module it would rewrite every label to
 * the very strings it is here to remove, so it checks the import before it
 * connects: the production case from the ticket, both ways round, plus the
 * anchor helper the SPA now uses.
 */
function assertFixedMath() {
  const beach = {
    periodLabelEnabled: true,
    frequency: 'specific-months',
    scheduledMonths: [2, 3, 5, 6, 8, 9, 11, 12],
    periodCoverageStart: '2026-08-01',
    periodCoverageEnd: '2026-08-31',
    periodCoverageAnchorDue: '2026-09-01',
  }
  const checks = [
    ['label on the occurrence the window was set for', periodLabelForInstance(beach, '2026-09-10'), 'August 1 – August 31, 2026'],
    [
      'label one occurrence on',
      periodLabelForInstance({ ...beach, periodCoverageAnchorDue: '2026-08-01' }, '2026-09-10'),
      'September 1 – September 30, 2026',
    ],
    ['anchor helper', typeof coverageAnchorForTemplate, 'function'],
    ['anchor for a window set in September', coverageAnchorForTemplate(beach, '2026-09-18'), '2026-09-01'],
  ]
  const failed = checks.filter(([, got, want]) => got !== want)
  if (failed.length === 0) return
  console.error('REFUSING: lib/checklist-period-label.js is not the fixed math.')
  for (const [what, got, want] of failed) {
    console.error(`   ${what}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`)
  }
  process.exit(2)
}

const TEMPLATE_SELECT = `
  select t.id, t.title, t.frequency, t.period_label_enabled, t.scheduled_months,
         coalesce(cl.name, '(no client)') as client_name,
         to_char(t.period_coverage_start, 'YYYY-MM-DD') as period_coverage_start,
         to_char(t.period_coverage_end, 'YYYY-MM-DD') as period_coverage_end,
         to_char(t.period_coverage_anchor_due, 'YYYY-MM-DD') as period_coverage_anchor_due,
         to_char(t.updated_at at time zone 'UTC', 'YYYY-MM-DD') as updated_on
    from checklist_templates t
    left join clients cl on cl.id = t.client_id
   order by cl.name asc, t.title asc
`

const CHECKLIST_SELECT = `
  select c.id, c.title, c.template_id, c.period_label,
         to_char(c.due_date, 'YYYY-MM-DD') as due_date,
         coalesce(cl.name, '(no client)') as client_name
    from checklists c
    left join clients cl on cl.id = c.client_id
   where c.template_id is not null
     and c.deleted_at is null
   order by cl.name asc, c.title asc, c.due_date asc
`

const templateOf = (row) => ({
  frequency: row.frequency,
  periodLabelEnabled: Boolean(row.period_label_enabled),
  scheduledMonths: Array.isArray(row.scheduled_months) ? row.scheduled_months : [],
  periodCoverageStart: row.period_coverage_start,
  periodCoverageEnd: row.period_coverage_end,
  periodCoverageAnchorDue: row.period_coverage_anchor_due,
})

/** Is this anchor the 1st of a month the recipe actually runs in? */
function anchorNamesAnOccurrence(anchor, months) {
  if (!anchor) return false
  return anchor.slice(8, 10) === '01' && months.includes(Number(anchor.slice(5, 7)))
}

async function fix() {
  assertFixedMath()
  await db.connect()

  const templateRows = (await db.query(TEMPLATE_SELECT)).rows
  const checklistRows = (await db.query(CHECKLIST_SELECT)).rows

  /* (a) the anchors ----------------------------------------------------- */
  const templatePlan = []
  const noAnchor = []
  const byId = new Map()
  for (const row of templateRows) {
    const template = templateOf(row)
    byId.set(row.id, template)
    if (template.frequency !== 'specific-months' || !template.periodLabelEnabled) continue
    const months = template.scheduledMonths
    if (months.length === 0) continue
    if (anchorNamesAnOccurrence(template.periodCoverageAnchorDue, months)) continue
    if (!template.periodCoverageAnchorDue) {
      // Nothing to re-anchor FROM, and inventing one would move labels on
      // occurrences nobody has complained about. Reported, never written.
      noAnchor.push(row)
      continue
    }
    const setOn = row.updated_on ?? template.periodCoverageAnchorDue
    const next = coverageAnchorForTemplate(template, setOn)
    if (!next || next === template.periodCoverageAnchorDue) continue
    templatePlan.push({
      id: row.id,
      title: row.title,
      clientName: row.client_name,
      setOn,
      before: template.periodCoverageAnchorDue,
      after: next,
    })
    // The recompute below has to see the CORRECTED cycle.
    template.periodCoverageAnchorDue = next
  }

  /* (b) the stored labels ------------------------------------------------ */
  const checklistPlan = []
  let blankLeftAlone = 0
  for (const row of checklistRows) {
    const template = byId.get(row.template_id)
    if (!template) continue
    // An empty string is a blank label, not a label reading '' — treated as a
    // pre-feature instance and left alone, same as the scan does.
    const before = row.period_label ? row.period_label : null
    const after = periodLabelForInstance(template, row.due_date)
    if (before === after) continue
    if (before === null) {
      blankLeftAlone += 1
      continue
    }
    checklistPlan.push({
      id: row.id,
      title: row.title,
      clientName: row.client_name,
      dueDate: row.due_date,
      templateId: row.template_id,
      before,
      after,
    })
  }

  /* the snapshot, BEFORE anything is written ----------------------------- */
  mkdirSync('docs/prod-snapshots', { recursive: true })
  const snapshotPath = `docs/prod-snapshots/${stamp}-period-labels-before-fix.json`
  writeFileSync(
    snapshotPath,
    JSON.stringify({ stamp, templates: templatePlan, checklists: checklistPlan }, null, 2) + '\n',
  )

  console.log(`snapshot: ${snapshotPath}`)
  console.log(
    `templates: ${templateRows.length} scanned, ${templatePlan.length} to re-anchor; ` +
      `checklists: ${checklistRows.length} scanned, ${checklistPlan.length} to relabel\n`,
  )

  console.log('--- anchors (a) ---')
  for (const p of templatePlan) {
    console.log(
      `${p.id} | client=${p.clientName} | title=${p.title} | anchor ${show(p.before)} -> ${p.after} | window set on ${p.setOn}`,
    )
  }
  if (noAnchor.length) {
    console.log(
      `\n${noAnchor.length} specific-months recipe(s) carry a window with NO anchor at all — left untouched, listed for your call:`,
    )
    for (const row of noAnchor) {
      console.log(`   ${row.id} | client=${row.client_name} | title=${row.title}`)
    }
  }

  console.log('\n--- labels (b) ---')
  for (const p of checklistPlan) {
    console.log(
      `${p.id} | client=${p.clientName} | title=${p.title} | due=${p.dueDate} | "${p.before}" -> ${
        p.after === null ? '(none)' : `"${p.after}"`
      }`,
    )
  }

  await db.query('begin')
  let templatesWritten = 0
  let checklistsWritten = 0
  for (const p of templatePlan) {
    const r = await db.query(
      `update checklist_templates set period_coverage_anchor_due = $2, updated_at = now() where id = $1`,
      [p.id, p.after],
    )
    templatesWritten += r.rowCount
  }
  for (const p of checklistPlan) {
    const r = await db.query(
      `update checklists set period_label = $2, updated_at = now() where id = $1`,
      [p.id, p.after],
    )
    checklistsWritten += r.rowCount
  }

  console.log('')
  console.log(`templates re-anchored:      ${templatesWritten}`)
  console.log(`checklist labels rewritten: ${checklistsWritten}`)
  console.log(`blank labels left alone:    ${blankLeftAlone} (pre-feature instances)`)
  if (apply) {
    await db.query('commit')
    console.log(`\nAPPLIED. Undo: node scripts/prod/fix-period-labels.mjs --undo ${snapshotPath} --apply`)
  } else {
    await db.query('rollback')
    console.log('\nDRY RUN: ROLLED BACK, nothing was written. Re-run with --apply to write.')
  }
  await db.end()
}

async function undo() {
  const snapshot = JSON.parse(readFileSync(undoPath, 'utf8'))
  const templates = Array.isArray(snapshot.templates) ? snapshot.templates : []
  const checklists = Array.isArray(snapshot.checklists) ? snapshot.checklists : []
  await db.connect()

  // Every touched row must still hold what this script wrote. One that does not
  // has been edited since, and putting the old value back would silently
  // discard that edit — so the whole undo is refused, not the one row.
  const drifted = []
  for (const entry of templates) {
    const row = (
      await db.query(
        `select to_char(period_coverage_anchor_due, 'YYYY-MM-DD') as anchor from checklist_templates where id = $1`,
        [entry.id],
      )
    ).rows[0]
    const current = row ? row.anchor : undefined
    if (current !== entry.after) {
      drifted.push(`template ${entry.id}: holds ${show(current)}, this script wrote ${show(entry.after)}`)
    }
  }
  for (const entry of checklists) {
    const row = (await db.query(`select period_label from checklists where id = $1`, [entry.id])).rows[0]
    const current = row ? (row.period_label ? row.period_label : null) : undefined
    if (current !== entry.after) {
      drifted.push(`checklist ${entry.id}: holds ${show(current)}, this script wrote ${show(entry.after)}`)
    }
  }
  if (drifted.length) {
    console.error(`REFUSING: ${drifted.length} row(s) have changed since the fix ran.`)
    for (const line of drifted) console.error(`   ${line}`)
    await db.end()
    process.exit(2)
  }

  await db.query('begin')
  let restored = 0
  for (const entry of templates) {
    const r = await db.query(
      `update checklist_templates set period_coverage_anchor_due = $2, updated_at = now() where id = $1`,
      [entry.id, entry.before],
    )
    restored += r.rowCount
    console.log(`template ${entry.id}: anchor ${show(entry.after)} -> ${show(entry.before)}`)
  }
  for (const entry of checklists) {
    const r = await db.query(
      `update checklists set period_label = $2, updated_at = now() where id = $1`,
      [entry.id, entry.before],
    )
    restored += r.rowCount
    console.log(`checklist ${entry.id}: label ${show(entry.after)} -> ${show(entry.before)}`)
  }
  if (apply) {
    await db.query('commit')
    console.log(`\nRESTORED ${restored} row(s) from ${undoPath}`)
  } else {
    await db.query('rollback')
    console.log(`\nDRY RUN: ${restored} row(s) would be restored from ${undoPath}. ROLLED BACK.`)
  }
  await db.end()
}

const run = undoPath ? undo : fix
run().catch((error) => {
  console.error('ERR', error.message)
  process.exit(1)
})
