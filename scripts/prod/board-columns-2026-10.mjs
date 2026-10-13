#!/usr/bin/env node
// One production write for Brittany's "Board Adjustments" email (2026-10-13):
// the Board's columns (service_categories) are renamed, ten are added, all of them
// are put in her order (and in her groups once `service_categories.group_name`
// exists), and the steps of seven checklists - the standard blueprint AND every
// client copy - are pointed at the new columns. Checklist instances that were only
// stamped with the old column when they were generated are cleared, so they follow
// their step from now on; anything somebody moved by hand stays where it is.
//
//   node scripts/prod/board-columns-2026-10.mjs            # dry run: snapshot + plan, nothing written
//   node scripts/prod/board-columns-2026-10.mjs --trial    # the same writes inside BEGIN ... ROLLBACK
//   node scripts/prod/board-columns-2026-10.mjs --apply    # the real write (one transaction) - Alex only
//
// How the Board picks a column (src/lib/activeBoard.ts resolveChecklistCategoryId):
// the instance's own category_id, else its step's category_id, else the template's
// category_id, else Uncategorized. So pointing a step at a column only moves the
// instances whose own category_id is NULL - hence part E below.
//
// What is matched: templates by exact trimmed title (STAGE_MAP keys), except the
// "Reconciliations with Review" family - any trimmed title ENDING in that phrase
// (Monthly / Quarterly / Annual ...) uses its step map. Steps by trimmed,
// case-insensitive name, including the listed aliases. A step on a matched template
// whose name is not in the map is printed and left alone - never guessed.
// Every matched template's default column becomes its FIRST step's column (when
// that step is matched), whatever it was before, so defaults are consistent.
//
// Connection: DATABASE_PUBLIC_URL or DATABASE_URL, else
// `npx @railway/cli@latest variables --service Postgres --json` (the folder must be
// linked). PGSSLMODE=no-verify because the Railway public proxy presents a
// certificate node-pg will not verify. Every write is set-based (unnest arrays), in
// one transaction with `set local lock_timeout = '5s'`, and each statement is
// guarded on the value it expects to replace: a row count that differs from the
// plan aborts the whole transaction.
//
// Snapshot: every run writes docs/prod-snapshots/2026-10-13-board-columns.json
// BEFORE any write (the full service_categories rows, every step row of the matched
// templates, the matched templates (id, title, client_id, category_id), the
// instances this run clears (id, template_id, stage_id, category_id), and the plan
// itself, including the ids of the columns it adds). A dry run's added ids are
// random and NOT the ones --apply uses: undo from the snapshot the --apply run
// wrote. After a successful --apply the file is marked "applied": true and a later
// run will not overwrite it (it writes a time-stamped file next to it instead).
//
// Undo (from the --apply snapshot, one transaction):
//   1. columns: for each serviceCategories row in the snapshot,
//        update service_categories set name = <name>, sort_order = <sort_order>
//          [, group_name = <group_name>  - only when the snapshot has the column]
//        where id = <id>;
//   2. delete from service_categories where id = any(<plan.adds[].id>);
//      (first null anything that points at them: checklist_template_stages,
//       checklist_templates and checklists .category_id = any(<those ids>))
//   3. steps:     update checklist_template_stages set category_id = <plan.stageChanges[].from> where id = <id>;
//   4. templates: update checklist_templates set category_id = <plan.templateDefaults[].from> (may be NULL) where id = <id>;
//   5. instances: update checklists set category_id = <plan.instancesNulled[].from> where id = <id> and category_id is null;

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Client } = require('pg')

const SNAPSHOT_PATH = 'docs/prod-snapshots/2026-10-13-board-columns.json'

// A. Renames - same id, so everything already in the column follows.
const RENAMES = [
  ['cat-89143b32', 'Clear Transactions', 'Accounting - Clear Feed'],
  ['cat-8fa12c3f', 'Reconciliations', 'Accounting - Reconciliations'],
  ['cat-79f2088a', 'Reviews', 'Accounting - Review'],
  ['cat-4c362f22', 'Consulting', 'Consulting - Client Call'],
  ['cat-8a8ed000', 'Payroll', 'Payroll - Run'],
  ['cat-8c898acc', 'Sales Tax', 'Sales Tax - Prepare'],
  ['cat-fada83b8', '1099 Preparation', '1099 Preparation - Prepare'],
  ['cat-b4c64293', 'Federal Returns - Confirm', 'Federal Returns - Client Approval'],
]

// B. New columns (skipped when the name already exists).
const ADDS = [
  'Accounting - Close',
  'Accounting - Send',
  'Payroll - Confirm',
  'Sales Tax - Approval',
  'Sales Tax - Send',
  '1099 Preparation - Client Approval',
  '1099 Preparation - Send',
  'Federal Returns - Send',
  'Budget',
  'Forecast',
]

// C. Order (sort_order 0.. top to bottom) and groups.
const GROUPS = [
  [
    'Year-End',
    [
      '1099 Preparation - Prepare',
      '1099 Preparation - Client Approval',
      '1099 Preparation - Send',
      'Federal Returns - Prepare',
      'Federal Returns - Client Approval',
      'Federal Returns - Send',
      'Annual State Compliance',
    ],
  ],
  [
    'Core Accounting',
    [
      'Accounting - Clear Feed',
      'Accounting - Reconciliations',
      'Accounting - Review',
      'Accounting - Close',
      'Accounting - Send',
    ],
  ],
  ['Consulting', ['Consulting - Client Call']],
  [
    'Accounting Operations',
    [
      'Accounts Payable',
      'Accounts Receivable',
      'Client Email',
      'Payroll - Run',
      'Payroll - Confirm',
      'Sales Tax - Prepare',
      'Sales Tax - Approval',
      'Sales Tax - Send',
    ],
  ],
  ['CFO & Advisory', ['Cash Flow', 'Budget', 'Forecast']],
]

// D. Step -> column, per template title.
const FEDERAL_RETURN_STEPS = [
  ['Prepare Return', 'Federal Returns - Prepare'],
  ['Send Preview to Client', 'Federal Returns - Client Approval'],
  ['File 1040', 'Federal Returns - Send'],
  ['File 1120S', 'Federal Returns - Send'], // "File 1040" on an 1120S copy is the same step (approved)
]
// Aliases are plain extra entries: an older wording of a step, same column.
const STAGE_MAP = {
  '1040 Tax Return': [...FEDERAL_RETURN_STEPS, ['Prepare Returns', 'Federal Returns - Prepare']],
  '1120S Tax Return': FEDERAL_RETURN_STEPS,
  '1099 Preparation and Filing': [
    ['Review GL for payments made to vendors', '1099 Preparation - Prepare'],
    ['Review GL after final transactions added for YE', '1099 Preparation - Prepare'],
    ['Send 1099 List to client for approval', '1099 Preparation - Client Approval'],
    ['Prepare and send 1099s', '1099 Preparation - Send'],
  ],
  'Monthly Reconciliations': [
    ['Clear Bank Feed', 'Accounting - Clear Feed'],
    ['Reconcile Statements', 'Accounting - Reconciliations'],
    ['Reconcile books to Statements', 'Accounting - Reconciliations'], // alias
  ],
  Payroll: [
    ['Confirm auto payroll ran correctly', 'Payroll - Run'],
    ['Confirm no outstanding items in QBO', 'Payroll - Confirm'],
    ['Run bi-weekly payroll', 'Payroll - Run'], // alias
    ['Run weekly payroll', 'Payroll - Run'], // alias
  ],
  'Reconciliations with Review': [
    ['Clear Bank Feed', 'Accounting - Clear Feed'],
    ['Reconcile books to Statements', 'Accounting - Reconciliations'],
    ['Review Books', 'Accounting - Review'],
    ['Close Books', 'Accounting - Close'],
    ['Close Bank', 'Accounting - Close'], // alias
    ['Send Reports to Client', 'Accounting - Send'],
    ['Client Call', 'Consulting - Client Call'],
  ],
  'Sales Tax Returns': [
    ['Prepare Reports', 'Sales Tax - Prepare'],
    ['Send Client report to approve for Sales Tax', 'Sales Tax - Approval'],
    ['File Sales Tax Return', 'Sales Tax - Send'],
  ],
}
const TITLES = Object.keys(STAGE_MAP)
const STAGE_LOOKUP = new Map(
  TITLES.map((title) => [title, new Map(STAGE_MAP[title].map(([step, column]) => [stepKey(step), column]))]),
)
// Any trimmed title ending in this phrase (Monthly / Quarterly / Annual ...) uses its map.
const FAMILY_SUFFIX = 'Reconciliations with Review'

/** The STAGE_MAP key a template title belongs to, or null. */
function familyOf(title) {
  const t = String(title ?? '').trim()
  if (STAGE_LOOKUP.has(t)) return t
  if (t.endsWith(FAMILY_SUFFIX)) return FAMILY_SUFFIX
  return null
}

function stepKey(name) {
  return String(name ?? '').trim().toLowerCase()
}
function nameKey(name) {
  return String(name ?? '').trim().toLowerCase()
}

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const trial = args.includes('--trial')
const unknown = args.filter((a) => a !== '--apply' && a !== '--trial')
if (unknown.length || (apply && trial)) {
  console.error('usage: node scripts/prod/board-columns-2026-10.mjs [--trial | --apply]')
  process.exit(1)
}
const MODE = apply ? 'apply' : trial ? 'trial' : 'dry-run'

function connectionString() {
  const fromEnv = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL
  if (fromEnv) return fromEnv
  const out = execFileSync('npx', ['@railway/cli@latest', 'variables', '--service', 'Postgres', '--json'], {
    encoding: 'utf8',
    shell: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const url = JSON.parse(out).DATABASE_PUBLIC_URL
  if (!url) throw new Error('DATABASE_PUBLIC_URL missing from railway variables output')
  return url
}

process.env.PGSSLMODE = 'no-verify'
const db = new Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } })

async function hasGroupColumn() {
  const r = await db.query(
    `select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'service_categories' and column_name = 'group_name'`,
  )
  return r.rowCount > 0
}

async function readState() {
  const categories = (await db.query(`select * from service_categories order by sort_order, name, id`)).rows
  const templates = (
    await db.query(
      `select id, title, client_id, category_id, is_standard, active, source_template_id, updated_at
         from checklist_templates
        where btrim(title) = any($1::text[]) or right(btrim(title), length($2::text)) = $2::text
        order by btrim(title), is_standard desc, id`,
      [TITLES, FAMILY_SUFFIX],
    )
  ).rows.filter((t) => familyOf(t.title) !== null)
  const templateIds = templates.map((t) => t.id)
  const stages = (
    await db.query(
      `select * from checklist_template_stages where template_id = any($1::text[]) order by template_id, position, id`,
      [templateIds],
    )
  ).rows
  const checklists = (
    await db.query(
      `select id, template_id, stage_id, category_id, updated_at
         from checklists
        where deleted_at is null and template_id = any($1::text[])
        order by id`,
      [templateIds],
    )
  ).rows
  return { categories, templates, stages, checklists }
}

function buildPlan(state, groupColumn) {
  const { categories, templates, stages, checklists } = state
  const byId = new Map(categories.map((c) => [c.id, c]))

  // A. renames
  const finalName = new Map(categories.map((c) => [c.id, c.name]))
  const renames = []
  const renamesAlreadyDone = []
  for (const [id, from, to] of RENAMES) {
    const row = byId.get(id)
    if (!row) throw new Error(`column ${id} ("${from}") is missing`)
    if (row.name === to) {
      renamesAlreadyDone.push({ id, name: to })
      continue
    }
    if (row.name !== from) throw new Error(`column ${id} is named "${row.name}", expected "${from}"`)
    const clash = categories.find((c) => c.id !== id && nameKey(c.name) === nameKey(to))
    if (clash) throw new Error(`cannot rename ${id} to "${to}": ${clash.id} already has that name`)
    renames.push({ id, from, to })
    finalName.set(id, to)
  }
  const idByName = new Map()
  for (const [id, name] of finalName) {
    if (idByName.has(nameKey(name))) throw new Error(`two columns are named "${name}"`)
    idByName.set(nameKey(name), id)
  }

  // B. adds
  const adds = []
  const addsSkipped = []
  for (const name of ADDS) {
    const existing = idByName.get(nameKey(name))
    if (existing) {
      addsSkipped.push({ id: existing, name })
      continue
    }
    let id
    do id = `cat-${randomUUID().slice(0, 8)}`
    while (finalName.has(id))
    adds.push({ id, name })
    finalName.set(id, name)
    idByName.set(nameKey(name), id)
  }

  // C. order + groups
  const ordered = []
  const groupOf = new Map()
  for (const [group, names] of GROUPS) {
    for (const name of names) {
      const id = idByName.get(nameKey(name))
      if (!id) throw new Error(`column "${name}" in the order list does not exist`)
      if (ordered.includes(id)) throw new Error(`column "${name}" is listed twice`)
      ordered.push(id)
      groupOf.set(id, group)
    }
  }
  const extras = categories.filter((c) => !ordered.includes(c.id))
  for (const c of extras) ordered.push(c.id)
  const columns = ordered.map((id, index) => ({
    id,
    name: finalName.get(id),
    sortOrder: index,
    group: groupOf.get(id) ?? null,
    isNew: !byId.has(id),
  }))
  const columnUpdates = columns.filter((col) => {
    const row = byId.get(col.id)
    if (!row) return false
    return (
      row.name !== col.name ||
      Number(row.sort_order) !== col.sortOrder ||
      (groupColumn && (row.group_name ?? null) !== col.group)
    )
  })
  const columnInserts = columns.filter((col) => col.isNew)

  // D. steps
  const templateById = new Map(templates.map((t) => [t.id, t]))
  const stageById = new Map(stages.map((s) => [s.id, s]))
  const stageTarget = new Map()
  const stageChanges = []
  const unmatched = []
  for (const s of stages) {
    const t = templateById.get(s.template_id)
    const title = t.title.trim()
    const family = familyOf(title)
    const column = STAGE_LOOKUP.get(family)?.get(stepKey(s.name))
    if (!column) {
      unmatched.push({ family, title, name: s.name, stageId: s.id, templateId: t.id, blueprint: t.is_standard, position: s.position })
      continue
    }
    const target = idByName.get(nameKey(column))
    if (!target) throw new Error(`step column "${column}" does not exist`)
    stageTarget.set(s.id, target)
    if (s.category_id !== target) {
      stageChanges.push({ id: s.id, templateId: t.id, family, title, name: s.name, blueprint: t.is_standard, from: s.category_id, to: target })
    }
  }

  // D (defaults). Every matched template's default becomes its first step's column.
  const templateDefaults = []
  const templateDefaultsSkipped = []
  const templateDefaultsUnchanged = []
  for (const t of templates) {
    const first = stages
      .filter((s) => s.template_id === t.id)
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))[0]
    const target = first ? stageTarget.get(first.id) : undefined
    if (!target) {
      templateDefaultsSkipped.push({ id: t.id, title: t.title.trim(), current: t.category_id, firstStep: first ? first.name : null })
      continue
    }
    if (t.category_id === target) {
      templateDefaultsUnchanged.push(t.id)
      continue
    }
    templateDefaults.push({
      id: t.id,
      family: familyOf(t.title),
      title: t.title.trim(),
      blueprint: t.is_standard,
      firstStep: first.name,
      from: t.category_id,
      to: target,
    })
  }

  // E. instances stamped with the old column of a re-pointed step follow the step.
  const changedStages = new Map(stageChanges.map((c) => [c.id, c]))
  const instancesNulled = []
  let handMoved = 0
  let stageOfOtherTemplate = 0
  for (const c of checklists) {
    if (!c.stage_id || !changedStages.has(c.stage_id) || c.category_id == null) continue
    const stage = stageById.get(c.stage_id)
    if (stage.template_id !== c.template_id) {
      stageOfOtherTemplate += 1
      continue
    }
    const template = templateById.get(c.template_id)
    if (c.category_id === stage.category_id || c.category_id === template.category_id) {
      instancesNulled.push({ id: c.id, templateId: c.template_id, title: template.title.trim(), stageId: c.stage_id, from: c.category_id })
    } else {
      handMoved += 1
    }
  }

  return {
    groupColumn,
    renames,
    renamesAlreadyDone,
    adds,
    addsSkipped,
    extras: extras.map((c) => ({ id: c.id, name: c.name })),
    columns,
    columnUpdates,
    columnInserts,
    stageChanges,
    unmatched,
    templateDefaults,
    templateDefaultsSkipped,
    templateDefaultsUnchanged,
    instancesNulled,
    handMoved,
    stageOfOtherTemplate,
  }
}

function columnLabel(names, id) {
  if (id == null) return '(none)'
  return names.get(id) ?? `${id} (missing)`
}

function countBy(rows, keyFn) {
  const out = new Map()
  for (const r of rows) {
    const k = keyFn(r)
    out.set(k, (out.get(k) ?? 0) + 1)
  }
  return out
}

function printPlan(state, plan) {
  const oldNames = new Map(state.categories.map((c) => [c.id, c.name]))
  const newNames = new Map(plan.columns.map((c) => [c.id, c.name]))
  console.log(`\n== A. renames: ${plan.renames.length}`)
  for (const r of plan.renames) console.log(`  ${r.id}  "${r.from}" -> "${r.to}"`)
  for (const r of plan.renamesAlreadyDone) console.log(`  ${r.id}  already "${r.name}" (skipped)`)

  console.log(`\n== B. adds: ${plan.adds.length}`)
  for (const a of plan.adds) console.log(`  ${a.id}  "${a.name}"`)
  for (const a of plan.addsSkipped) console.log(`  "${a.name}" already exists as ${a.id} (skipped)`)

  console.log(`\n== C. order${plan.groupColumn ? ' + groups' : ''}: ${plan.columns.length} columns, ${plan.columnUpdates.length} existing rows change, ${plan.columnInserts.length} inserted`)
  if (!plan.groupColumn) console.log('  groups skipped - column not there yet')
  for (const c of plan.columns) {
    const old = state.categories.find((x) => x.id === c.id)
    const was = old ? `was #${old.sort_order} "${old.name}"` : 'NEW'
    console.log(`  ${String(c.sortOrder).padStart(2)}  ${c.id}  ${c.name.padEnd(36)} ${(c.group ?? '(no group)').padEnd(22)} ${was}`)
  }
  if (plan.extras.length) {
    console.log(`  WARNING: ${plan.extras.length} column(s) not in her list, kept at the end without a group: ${plan.extras.map((e) => `"${e.name}"`).join(', ')}`)
  }

  console.log(`\n== D. steps re-pointed: ${plan.stageChanges.length}`)
  const summarize = (label, templates, changes) => {
    const blueprints = templates.filter((t) => t.is_standard).length
    const blueprintSteps = changes.filter((c) => c.blueprint).length
    const copyIds = new Set(changes.filter((c) => !c.blueprint).map((c) => c.templateId))
    console.log(
      `${label.padEnd(48)} templates ${String(templates.length).padStart(2)} (${blueprints} blueprint) | blueprint ${blueprintSteps} steps | ${copyIds.size} copies ${changes.length - blueprintSteps} steps`,
    )
  }
  for (const family of TITLES) {
    const familyTemplates = state.templates.filter((t) => familyOf(t.title) === family)
    const changes = plan.stageChanges.filter((c) => c.family === family)
    summarize(`  ${family}${family === FAMILY_SUFFIX ? ' (family)' : ''}`, familyTemplates, changes)
    const titles = [...new Set(familyTemplates.map((t) => t.title.trim()))]
    if (titles.length > 1) {
      for (const title of titles) {
        summarize(
          `      "${title}"`,
          familyTemplates.filter((t) => t.title.trim() === title),
          changes.filter((c) => c.title === title),
        )
      }
    }
    const perStep = countBy(changes, (c) => `${c.name.trim()} -> ${columnLabel(newNames, c.to)}`)
    for (const [k, n] of perStep) console.log(`      ${String(n).padStart(3)} x ${k}`)
  }

  console.log(`\n== D. unmatched step names (left unchanged): ${plan.unmatched.length} steps`)
  const unmatchedGroups = new Map()
  for (const u of plan.unmatched) {
    const k = `${u.title} | "${u.name}"`
    const g = unmatchedGroups.get(k) ?? { n: 0, blueprint: 0, templates: [] }
    g.n += 1
    if (u.blueprint) g.blueprint += 1
    g.templates.push(u.templateId)
    unmatchedGroups.set(k, g)
  }
  for (const [k, g] of unmatchedGroups) {
    console.log(`  ${String(g.n).padStart(3)} x ${k}${g.blueprint ? ' (incl. blueprint)' : ''}  [${g.templates.join(' ')}]`)
  }

  console.log(
    `\n== D. template defaults set: ${plan.templateDefaults.length} (already right: ${plan.templateDefaultsUnchanged.length}; not set: ${plan.templateDefaultsSkipped.length})`,
  )
  for (const [k, n] of countBy(
    plan.templateDefaults,
    (d) => `${d.title}: ${columnLabel(newNames, d.from)} -> ${columnLabel(newNames, d.to)} (first step "${d.firstStep}")`,
  )) {
    console.log(`  ${String(n).padStart(3)} x ${k}`)
  }
  for (const s of plan.templateDefaultsSkipped) {
    console.log(
      `  NOT SET ${s.id} ${s.title} (stays ${columnLabel(newNames, s.current)}): first step ${s.firstStep ? `"${s.firstStep}" is unmatched` : 'missing'}`,
    )
  }

  console.log(`\n== E. instances nulled: ${plan.instancesNulled.length} (hand-moved, kept: ${plan.handMoved}; step from another template, skipped: ${plan.stageOfOtherTemplate})`)
  for (const [k, n] of countBy(plan.instancesNulled, (i) => i.title)) console.log(`  by template  ${String(n).padStart(4)}  ${k}`)
  for (const [k, n] of countBy(plan.instancesNulled, (i) => i.from)) {
    console.log(`  by old column ${String(n).padStart(4)}  ${k} (was "${columnLabel(oldNames, k)}", now "${columnLabel(newNames, k)}")`)
  }
  console.log(`\n== BEFORE: where every live instance of these templates lands on the Board today`)
  for (const [k, n] of resolvedDistribution(state)) console.log(`  ${String(n).padStart(4)}  ${k}`)
}

/** Where every live instance of a matched template lands on the Board, by title. */
function resolvedDistribution(state) {
  const stageCat = new Map(state.stages.map((s) => [s.id, s.category_id]))
  const tplById = new Map(state.templates.map((t) => [t.id, t]))
  const names = new Map(state.categories.map((c) => [c.id, c.name]))
  const out = new Map()
  for (const c of state.checklists) {
    const t = tplById.get(c.template_id)
    const resolved = c.category_id || (c.stage_id && stageCat.get(c.stage_id)) || t.category_id || null
    const key = `${t.title.trim()} -> ${resolved ? names.get(resolved) ?? resolved : 'Uncategorized'}`
    out.set(key, (out.get(key) ?? 0) + 1)
  }
  return [...out].sort((a, b) => a[0].localeCompare(b[0]))
}

async function executeWrites(plan) {
  const g = plan.groupColumn
  const expect = (label, result, n) => {
    if (result.rowCount !== n) throw new Error(`${label}: expected ${n} rows, got ${result.rowCount} - rolled back`)
    console.log(`  ${label}: ${result.rowCount}`)
  }
  if (plan.columnInserts.length) {
    const ins = plan.columnInserts
    const r = await db.query(
      g
        ? `insert into service_categories (id, name, sort_order, group_name, updated_at)
           select u.id, u.name, u.ord, u.grp, now()
             from unnest($1::text[], $2::text[], $3::int[], $4::text[]) as u(id, name, ord, grp)`
        : `insert into service_categories (id, name, sort_order, updated_at)
           select u.id, u.name, u.ord, now()
             from unnest($1::text[], $2::text[], $3::int[]) as u(id, name, ord)`,
      g
        ? [ins.map((c) => c.id), ins.map((c) => c.name), ins.map((c) => c.sortOrder), ins.map((c) => c.group)]
        : [ins.map((c) => c.id), ins.map((c) => c.name), ins.map((c) => c.sortOrder)],
    )
    expect('service_categories inserted', r, ins.length)
  }
  if (plan.columnUpdates.length) {
    const up = plan.columnUpdates
    const r = await db.query(
      g
        ? `update service_categories c
              set name = u.name, sort_order = u.ord, group_name = u.grp, updated_at = now()
             from unnest($1::text[], $2::text[], $3::int[], $4::text[]) as u(id, name, ord, grp)
            where c.id = u.id`
        : `update service_categories c
              set name = u.name, sort_order = u.ord, updated_at = now()
             from unnest($1::text[], $2::text[], $3::int[]) as u(id, name, ord)
            where c.id = u.id`,
      g
        ? [up.map((c) => c.id), up.map((c) => c.name), up.map((c) => c.sortOrder), up.map((c) => c.group)]
        : [up.map((c) => c.id), up.map((c) => c.name), up.map((c) => c.sortOrder)],
    )
    expect('service_categories updated', r, up.length)
  }
  if (plan.stageChanges.length) {
    const sc = plan.stageChanges
    const r = await db.query(
      `update checklist_template_stages s
          set category_id = u.cat, updated_at = now()
         from unnest($1::text[], $2::text[], $3::text[]) as u(id, cat, old)
        where s.id = u.id and s.category_id is not distinct from u.old`,
      [sc.map((c) => c.id), sc.map((c) => c.to), sc.map((c) => c.from)],
    )
    expect('checklist_template_stages re-pointed', r, sc.length)
  }
  if (plan.templateDefaults.length) {
    const td = plan.templateDefaults
    const r = await db.query(
      `update checklist_templates t
          set category_id = u.cat, updated_at = now()
         from unnest($1::text[], $2::text[], $3::text[]) as u(id, cat, old)
        where t.id = u.id and t.category_id is not distinct from u.old`,
      [td.map((d) => d.id), td.map((d) => d.to), td.map((d) => d.from)],
    )
    expect('checklist_templates default set', r, td.length)
  }
  if (plan.instancesNulled.length) {
    const inn = plan.instancesNulled
    const r = await db.query(
      `update checklists c
          set category_id = null, updated_at = now()
         from unnest($1::text[], $2::text[]) as u(id, old)
        where c.id = u.id and c.deleted_at is null and c.category_id = u.old`,
      [inn.map((i) => i.id), inn.map((i) => i.from)],
    )
    expect('checklists category cleared', r, inn.length)
  }
}

async function printAfter(plan, label) {
  const groupColumn = plan.groupColumn
  const after = await readState()
  const names = new Map(after.categories.map((c) => [c.id, c.name]))
  console.log(`\n== ${label}: columns in order (${after.categories.length})`)
  for (const c of after.categories) {
    console.log(`  ${String(c.sort_order).padStart(2)}  ${c.id}  ${c.name.padEnd(36)} ${groupColumn ? c.group_name ?? '(no group)' : ''}`)
  }
  console.log(`\n== ${label}: step -> column, blueprint and one sample copy per template title`)
  const matchedTitles = [...new Set(after.templates.map((t) => t.title.trim()))].sort()
  for (const title of matchedTitles) {
    const ofTitle = after.templates.filter((t) => t.title.trim() === title)
    const blueprint = ofTitle.find((t) => t.is_standard)
    const copy = ofTitle.find((t) => !t.is_standard && after.stages.some((s) => s.template_id === t.id))
    for (const [kind, t] of [['blueprint', blueprint], ['copy', copy]]) {
      if (!t) {
        console.log(`  ${title} [${kind}]: none`)
        continue
      }
      console.log(`  ${title} [${kind} ${t.id}${t.client_id ? ' ' + t.client_id : ''}] default -> ${columnLabel(names, t.category_id)}`)
      for (const s of after.stages.filter((x) => x.template_id === t.id)) {
        console.log(`      ${String(s.position).padStart(2)}  ${s.name.padEnd(50)} -> ${columnLabel(names, s.category_id)}`)
      }
    }
  }
  const ids = new Set(plan.instancesNulled.map((i) => i.id))
  const stillSet = after.checklists.filter((c) => ids.has(c.id) && c.category_id != null).length
  console.log(`\n== ${label}: instances - planned to clear ${ids.size}, still set ${stillSet}`)
  console.log(`== ${label}: where every live instance of these templates now lands on the Board`)
  for (const [k, n] of resolvedDistribution(after)) console.log(`  ${String(n).padStart(4)}  ${k}`)
  return after
}

function fingerprint(state, groupColumn) {
  return JSON.stringify({
    categories: state.categories.map((c) => [c.id, c.name, c.sort_order, groupColumn ? c.group_name : null, String(c.updated_at)]),
    templates: state.templates.map((t) => [t.id, t.category_id, String(t.updated_at)]),
    stages: state.stages.map((s) => [s.id, s.category_id, String(s.updated_at)]),
    checklists: state.checklists.map((c) => [c.id, c.category_id, String(c.updated_at)]),
  })
}

function writeSnapshot(state, plan) {
  mkdirSync('docs/prod-snapshots', { recursive: true })
  let path = SNAPSHOT_PATH
  if (existsSync(path)) {
    try {
      if (JSON.parse(readFileSync(path, 'utf8')).applied === true) {
        path = SNAPSHOT_PATH.replace(/\.json$/, `-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
        console.log(`the applied snapshot ${SNAPSHOT_PATH} is kept; this run writes ${path}`)
      }
    } catch {
      // unreadable: overwrite it
    }
  }
  const affectedStageTemplates = new Set(state.stages.map((s) => s.template_id))
  const snapshot = {
    takenAt: new Date().toISOString(),
    mode: MODE,
    applied: false,
    groupNameColumn: plan.groupColumn,
    serviceCategories: state.categories,
    checklistTemplateStages: state.stages.filter((s) => affectedStageTemplates.has(s.template_id)),
    checklistTemplates: state.templates.map((t) => ({ id: t.id, title: t.title, client_id: t.client_id, category_id: t.category_id })),
    checklists: state.checklists
      .filter((c) => plan.instancesNulled.some((i) => i.id === c.id))
      .map((c) => ({ id: c.id, template_id: c.template_id, stage_id: c.stage_id, category_id: c.category_id })),
    plan: {
      renames: plan.renames,
      adds: plan.adds,
      columns: plan.columns,
      stageChanges: plan.stageChanges,
      unmatched: plan.unmatched,
      templateDefaults: plan.templateDefaults,
      templateDefaultsSkipped: plan.templateDefaultsSkipped,
      instancesNulled: plan.instancesNulled,
    },
  }
  writeFileSync(path, JSON.stringify(snapshot, null, 2) + '\n')
  console.log('snapshot', path)
  return path
}

let open = false
try {
  await db.connect()
  console.log(`mode: ${MODE}`)
  await db.query(MODE === 'dry-run' ? 'begin read only' : 'begin')
  open = true
  await db.query(`set local lock_timeout = '5s'`)
  await db.query(`set local statement_timeout = '60s'`)

  const groupColumn = await hasGroupColumn()
  const before = await readState()
  console.log(
    `read: ${before.categories.length} columns, ${before.templates.length} matched templates, ${before.stages.length} steps, ${before.checklists.length} live instances; group_name column: ${groupColumn ? 'yes' : 'no'}`,
  )
  const plan = buildPlan(before, groupColumn)
  const snapshotPath = writeSnapshot(before, plan)
  printPlan(before, plan)

  if (MODE === 'dry-run') {
    await db.query('rollback')
    open = false
    console.log('\nDRY RUN - nothing written (pass --trial to rehearse, --apply to write)')
  } else {
    if (!existsSync(snapshotPath)) throw new Error('snapshot was not written - refusing to write')
    console.log(`\n== writing (${MODE})`)
    await executeWrites(plan)
    await printAfter(plan, MODE === 'trial' ? 'TRIAL after (inside the transaction)' : 'after (before COMMIT)')
    if (MODE === 'trial') {
      await db.query('rollback')
      open = false
      const again = await readState()
      const same = fingerprint(again, groupColumn) === fingerprint(before, groupColumn)
      console.log(
        `\n== after ROLLBACK: ${same ? 'identical to before' : 'DIFFERENT FROM BEFORE'} (${again.categories.length} columns, ${again.templates.length} templates, ${again.stages.length} steps, ${again.checklists.length} live instances)`,
      )
      if (!same) process.exitCode = 1
      console.log('TRIAL - rolled back, nothing written')
    } else {
      await db.query('commit')
      open = false
      const snap = JSON.parse(readFileSync(snapshotPath, 'utf8'))
      snap.applied = true
      snap.appliedAt = new Date().toISOString()
      writeFileSync(snapshotPath, JSON.stringify(snap, null, 2) + '\n')
      console.log(`\nCOMMITTED (snapshot ${snapshotPath} marked applied)`)
    }
  }
} catch (error) {
  console.error('FAILED', error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error)
  process.exitCode = 1
} finally {
  if (open) {
    try {
      await db.query('rollback')
      console.error('rolled back')
    } catch {
      // connection already gone
    }
  }
  await db.end()
}
