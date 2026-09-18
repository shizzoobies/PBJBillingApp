#!/usr/bin/env node
/**
 * READ-ONLY. Lists every checklist whose STORED `period_label` disagrees with
 * what the corrected `periodLabelForInstance` computes from its template and its
 * own due date.
 *
 *   npx @railway/cli@latest variables --service Postgres --json \
 *     | node scripts/prod/scan-period-labels.mjs           rows that HAVE a label
 *     | node scripts/prod/scan-period-labels.mjs --all      and the unlabeled ones too
 *
 * By default only rows with a STORED label are listed. The unlabeled ones are
 * instances that spawned before the feature existed — the label stamps "every
 * occurrence from now on", so a blank one is correct as it stands and burying
 * seventeen real disagreements under five hundred blanks helps nobody. Both
 * counts are always printed; `--all` lists the blanks as well.
 *
 * `period_label` is stamped at spawn (db/store.js, `buildChecklistFromStage`)
 * and then stored, so fixing the label math does NOT fix the rows already
 * written — featreq-053fccba's "October 31 – November 30, 2026" is sitting in a
 * column. This is the inventory of what that costs, nothing more: it opens a
 * READ ONLY transaction, runs two selects and rolls back. There is no --apply
 * and no write path to reach; a fixer is a separate, approved decision.
 *
 * A row disagrees when the stored label differs from the computed one, which
 * includes a stored label whose template no longer carries a window at all
 * (computed "(none)") and a missing label the template would now produce.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { periodLabelForInstance } from '../../lib/checklist-period-label.js'

const require = createRequire(import.meta.url)
const { Client } = require('pg')

const all = process.argv.includes('--all')
const vars = JSON.parse(readFileSync(0, 'utf8'))
if (!vars.DATABASE_PUBLIC_URL) {
  // Loudly, because `new Client({ connectionString: undefined })` quietly falls
  // back to libpq's own defaults and would scan whatever local database the
  // environment happens to point at.
  console.error('DATABASE_PUBLIC_URL missing from stdin JSON')
  process.exit(1)
}

const db = new Client({
  connectionString: vars.DATABASE_PUBLIC_URL,
  ssl: { rejectUnauthorized: false },
})

const show = (value) => (value === null || value === undefined ? '(none)' : value)

async function main() {
  await db.connect()
  // Belt and braces: the connection cannot write even if something below tried.
  await db.query('begin read only')

  const templates = await db.query(`
    select id, frequency, period_label_enabled, scheduled_months,
           to_char(period_coverage_start, 'YYYY-MM-DD') as period_coverage_start,
           to_char(period_coverage_end, 'YYYY-MM-DD') as period_coverage_end,
           to_char(period_coverage_anchor_due, 'YYYY-MM-DD') as period_coverage_anchor_due
      from checklist_templates
  `)
  const templateById = new Map(
    templates.rows.map((row) => [
      row.id,
      {
        frequency: row.frequency,
        periodLabelEnabled: Boolean(row.period_label_enabled),
        scheduledMonths: Array.isArray(row.scheduled_months) ? row.scheduled_months : [],
        periodCoverageStart: row.period_coverage_start,
        periodCoverageEnd: row.period_coverage_end,
        periodCoverageAnchorDue: row.period_coverage_anchor_due,
      },
    ]),
  )

  const checklists = await db.query(`
    select c.id, c.title, c.template_id, c.period_label,
           to_char(c.due_date, 'YYYY-MM-DD') as due_date,
           coalesce(cl.name, '(no client)') as client_name
      from checklists c
      left join clients cl on cl.id = c.client_id
     where c.template_id is not null
       and c.deleted_at is null
     order by cl.name asc, c.title asc, c.due_date asc
  `)

  let scanned = 0
  let labeled = 0
  let unlabeled = 0
  for (const row of checklists.rows) {
    const template = templateById.get(row.template_id)
    if (!template) continue
    scanned += 1
    // An empty string is a blank label, not a label reading '' — a row stored
    // that way is a pre-feature instance like any other null.
    const stored = row.period_label ? row.period_label : null
    const computed = periodLabelForInstance(template, row.due_date)
    if (stored === computed) continue
    if (stored === null) unlabeled += 1
    else labeled += 1
    if (stored === null && !all) continue
    console.log(
      [
        row.id,
        `client=${row.client_name}`,
        `title=${row.title}`,
        `due=${show(row.due_date)}`,
        `template=${row.template_id}`,
        `stored=${show(stored)}`,
        `computed=${show(computed)}`,
      ].join(' | '),
    )
  }

  await db.query('rollback')
  console.log(
    `\nDRY RUN (read-only): ${labeled + unlabeled} of ${scanned} checklists with a template disagree with the corrected label.`,
  )
  console.log(`  with a stored label (what matters): ${labeled}${all ? '' : ' — listed above'}`)
  console.log(
    `  stored label is blank (pre-feature instances, correct as they are): ${unlabeled}${
      all ? ' — listed above' : ' — re-run with --all to list them'
    }`,
  )
  console.log('NOTHING WAS WRITTEN.')
  await db.end()
}

main().catch((error) => {
  console.error('ERR', error.message)
  process.exit(1)
})
