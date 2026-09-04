#!/usr/bin/env node
/**
 * One-time production reset of `clients.assigned_bookkeeper_ids` to the
 * EXPLICIT picks — docs/plans/team-visibility-split-2026-09.md §3.5.
 *
 * Why: until 2026-09-04 every task assignment wrote its assignee into the
 * team list, so the list is "everyone who ever had a checklist here". After
 * the split, task visibility is computed at read time and the team list must
 * be only what an owner picked. The array cannot tell a deliberate pick from a
 * task-derived one, so the rule is: KEEP an id on a client only when that
 * person has NO task on the client (a checklist, a recurring template, or a
 * template stage) — if there is no task, nothing but a human pick could have
 * put them there. Everything else is dropped; the person keeps seeing the
 * client through computed visibility, and Brittany re-picks the real team.
 * Owners on a list are kept (display fact, not a grant).
 *
 * Modes:
 *   node scripts/prod/reset-team-lists-2026-09.mjs            dry run: prints the plan, ROLLBACK
 *   node scripts/prod/reset-team-lists-2026-09.mjs --apply    writes, after printing the same plan
 *
 * Both modes write a JSON snapshot of every client's CURRENT team list to
 * docs/prod-snapshots/ first — that file is the undo (see the bottom of the
 * output for the restore statement). Connection: DATABASE_PUBLIC_URL on stdin
 * as the Railway variables JSON (never printed):
 *   npx @railway/cli@latest variables --service Postgres --json | node scripts/prod/reset-team-lists-2026-09.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Client } = require('pg')

const apply = process.argv.includes('--apply')
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

async function main() {
  await db.connect()
  const users = (await db.query(`select id, name, role from users`)).rows
  const nameOf = Object.fromEntries(users.map((u) => [u.id, u.name]))
  const ownerIds = new Set(users.filter((u) => u.role === 'owner').map((u) => u.id))
  const clients = (
    await db.query(`select id, name, assigned_bookkeeper_ids as team from clients order by name`)
  ).rows

  // Task sources — the same three backfillAssignedBookkeepers used.
  const tasks = new Map() // clientId -> Set(userId)
  const grant = (cid, uid) => {
    if (!cid || !uid) return
    if (!tasks.has(cid)) tasks.set(cid, new Set())
    tasks.get(cid).add(uid)
  }
  for (const r of (await db.query(`select client_id, assignee_id from checklists`)).rows) {
    grant(r.client_id, r.assignee_id)
  }
  for (const r of (await db.query(`select client_id, assignee_id from checklist_templates`)).rows) {
    grant(r.client_id, r.assignee_id)
  }
  for (const r of (
    await db.query(
      `select t.client_id, s.assignee_id
         from checklist_template_stages s join checklist_templates t on t.id = s.template_id`,
    )
  ).rows) {
    grant(r.client_id, r.assignee_id)
  }

  // Snapshot first — the undo.
  mkdirSync('docs/prod-snapshots', { recursive: true })
  const snapshotPath = `docs/prod-snapshots/${stamp}-team-lists-before-reset.json`
  writeFileSync(
    snapshotPath,
    JSON.stringify(
      clients.map((c) => ({ id: c.id, name: c.name, assignedBookkeeperIds: c.team ?? [] })),
      null,
      2,
    ) + '\n',
  )

  const plan = []
  for (const c of clients) {
    const current = c.team ?? []
    const taskIds = tasks.get(c.id) ?? new Set()
    const keep = current.filter((id) => ownerIds.has(id) || !taskIds.has(id))
    const drop = current.filter((id) => !keep.includes(id))
    if (drop.length) plan.push({ id: c.id, name: c.name, keep, drop })
  }

  console.log(`snapshot: ${snapshotPath}`)
  console.log(`clients: ${clients.length}; to change: ${plan.length}\n`)
  for (const p of plan) {
    console.log(
      `${p.name}\n   keep: [${p.keep.map((id) => nameOf[id] ?? id).join(', ')}]\n   drop: [${p.drop.map((id) => nameOf[id] ?? id).join(', ')}]`,
    )
  }

  // Prove nobody loses visibility: for each non-owner, computed visibility
  // AFTER (kept team ∪ tasks) must equal the current list (which IS team ∪
  // tasks today, by construction) — any difference is a bug in this script.
  console.log('\nvisibility check (after must equal before for every non-owner):')
  const after = new Map(clients.map((c) => [c.id, (plan.find((p) => p.id === c.id)?.keep ?? c.team ?? [])]))
  for (const u of users.filter((x) => x.role !== 'owner')) {
    const before = new Set(clients.filter((c) => (c.team ?? []).includes(u.id)).map((c) => c.id))
    const afterVis = new Set()
    for (const c of clients) {
      if (after.get(c.id).includes(u.id) || (tasks.get(c.id) ?? new Set()).has(u.id)) afterVis.add(c.id)
    }
    const lost = [...before].filter((id) => !afterVis.has(id))
    const gained = [...afterVis].filter((id) => !before.has(id))
    console.log(
      `   ${u.name}: before ${before.size}, after ${afterVis.size}, lost ${lost.length}, gained ${gained.length}${
        gained.length ? ' (gained = task-only clients not yet in the array: ' + gained.map((id) => clients.find((c) => c.id === id)?.name).join('; ') + ')' : ''
      }`,
    )
    if (lost.length) {
      console.error(`   REFUSING: ${u.name} would lose visibility of ${lost.length} client(s)`)
      process.exit(2)
    }
  }

  await db.query('begin')
  let changed = 0
  for (const p of plan) {
    const r = await db.query(
      `update clients set assigned_bookkeeper_ids = $2, updated_at = now() where id = $1`,
      [p.id, p.keep],
    )
    changed += r.rowCount
  }
  if (apply) {
    await db.query('commit')
    console.log(`\nAPPLIED: ${changed} client rows updated.`)
  } else {
    await db.query('rollback')
    console.log(`\nDRY RUN: ${changed} client rows would change. ROLLED BACK. Re-run with --apply to write.`)
  }
  console.log(
    `\nUNDO (from the snapshot): for each entry, update clients set assigned_bookkeeper_ids = $ids where id = $id — scripts/prod/restore-team-lists.mjs <snapshot> does exactly that.`,
  )
  await db.end()
}

main().catch((error) => {
  console.error('ERR', error.message)
  process.exit(1)
})
