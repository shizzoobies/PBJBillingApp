#!/usr/bin/env node
// One approved production write (Alex, 2026-10-06 night, tracker featreq-f0b4934f):
// the time on the holding client "[Review] CLEAN UP/SPLIT PROJECT" is split EVENLY
// across sixteen Sorensen-family clients, through the app's own
// `splitTimeEntry` (every slice keeps the date, description, person, clock in/out
// and billable flag; the original is deleted in the same unit of work), and the
// slices are then approved in one step so they do not flood the approval queue.
//
//   node scripts/prod/split-cleanup-project-2026-10.mjs            # dry run: snapshot + plan
//   node scripts/prod/split-cleanup-project-2026-10.mjs --apply    # do it
//
// Connection: DATABASE_PUBLIC_URL or DATABASE_URL. The store is built the way the
// server builds it; PGSSLMODE=no-verify is set here because the Railway public
// proxy presents a certificate node-pg will not verify.
//
// Undo: the snapshot JSON holds the eleven original rows in full. To reverse,
// delete every time_entries row whose group_id is in the printed list, and
// re-insert the snapshot rows (all columns are there).

import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Pool } = require('pg')

const HOLDING_CLIENT = 'client-seed-clean-up-split-project'
const ACTOR = 'emp-alex-anderson'
const TARGETS = [
  ['1969 Beach', 'client-wdmb88x'],
  ['51 Beach', 'client-rryq1yn'],
  ['5 Sunset', 'client-j1kaxr2'],
  ['FHS Partnership', 'client-2drk4li'],
  ["Let's Eat", 'client-h8rwhnn'],
  ["Let's Fish", 'client-o4zfkfz'],
  ['N568RT', 'client-yqkey3m'],
  ['Old No 1', 'client-96svwyc'],
  ['R68', 'client-viov05e'],
  ['Robin & Tabitha', 'client-fc88ygp'],
  ['Robin O Sorensen Family', 'client-mv4vrwv'],
  ['Robin O Sorensen Living', 'client-j17sdts'],
  ['San Jose Partners', 'client-vjecmxj'],
  ['Robin & Tabitha Sorensen Family Foundation', 'client-xmozesp'],
  ['Sorensen Brothers', 'client-lz1wlvi'],
  ['Tabitha Leigh Sorensen 2021', 'client-tjfzeqv'],
  ['Tabitha L Sorensen Family', 'client-5dxovmv'],
  ['Westview', 'client-nn18dtd'],
]

const apply = process.argv.includes('--apply')
const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_PUBLIC_URL (or DATABASE_URL) is required')
  process.exit(1)
}
process.env.DATABASE_URL = url
process.env.PGSSLMODE = 'no-verify'

const { AppDataStore } = await import('../../db/store.js')
const store = new AppDataStore()
if (store.mode !== 'postgres') throw new Error('store did not come up in postgres mode')
const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 })

/** Whole minutes, remainder spread one minute at a time from the first target. */
function evenAllocations(minutes) {
  const n = TARGETS.length
  const base = Math.floor(minutes / n)
  const extra = minutes - base * n
  // The app refuses a zero-minute allocation, so a very short entry simply
  // reaches fewer clients (its minutes still all land, nothing is lost).
  return TARGETS.map(([, clientId], index) => ({ clientId, minutes: base + (index < extra ? 1 : 0) })).filter(
    (row) => row.minutes > 0,
  )
}

try {
  const names = await pool.query(`select id, name from clients where id = any($1::text[])`, [
    TARGETS.map(([, id]) => id),
  ])
  if (names.rows.length !== TARGETS.length) {
    const found = new Set(names.rows.map((r) => r.id))
    throw new Error('missing clients: ' + TARGETS.filter(([, id]) => !found.has(id)).map(([n]) => n).join(', '))
  }
  const originals = await pool.query(
    `select * from time_entries where client_id = $1 order by entry_date, id`,
    [HOLDING_CLIENT],
  )
  if (originals.rows.length === 0) throw new Error('nothing left on the holding client')
  const totalMinutes = originals.rows.reduce((s, r) => s + Number(r.minutes), 0)
  console.log(`originals: ${originals.rows.length} entries, ${totalMinutes} minutes, ${TARGETS.length} targets`)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  mkdirSync('docs/prod-snapshots', { recursive: true })
  const snapshotPath = `docs/prod-snapshots/${stamp}-cleanup-split-before.json`
  writeFileSync(snapshotPath, JSON.stringify(originals.rows, null, 2) + '\n')
  console.log('snapshot', snapshotPath)

  const plan = originals.rows.map((row) => ({
    id: row.id,
    user: row.user_id,
    date: String(row.entry_date).slice(0, 15),
    minutes: Number(row.minutes),
    allocations: evenAllocations(Number(row.minutes)),
  }))
  for (const p of plan) {
    const mins = p.allocations.map((a) => a.minutes)
    console.log(`  ${p.id} ${p.user} ${p.date} ${p.minutes}m -> ${mins.join('/')} (sum ${mins.reduce((a, b) => a + b, 0)})`)
  }

  if (!apply) {
    console.log('DRY RUN - nothing written (pass --apply)')
  } else {
    const groupIds = []
    const createdIds = []
    for (const p of plan) {
      const groupId = `grp-${Math.random().toString(36).slice(2, 9)}`
      const result = await store.splitTimeEntry(p.id, p.allocations, ACTOR, groupId, 'even')
      groupIds.push(groupId)
      for (const row of result.created) createdIds.push(row.id)
      console.log(`  split ${p.id} -> ${result.created.length} slices (group ${groupId}), deleted ${result.deletedId}`)
    }
    const approved = await store.approveTimeEntries(createdIds, ACTOR)
    console.log(`approved ${Array.isArray(approved) ? approved.length : createdIds.length} slices as ${ACTOR}`)
    console.log('group ids:', groupIds.join(' '))

    const check = await pool.query(
      `select c.name, count(*)::int as slices, sum(minutes)::int as minutes,
              count(*) filter (where approval_status = 'approved')::int as approved
         from time_entries t join clients c on c.id = t.client_id
        where t.group_id = any($1::text[]) group by c.name order by c.name`,
      [groupIds],
    )
    for (const r of check.rows) console.log(`  ${r.name.padEnd(48)} ${String(r.slices).padStart(3)} slices ${String(r.minutes).padStart(4)} min  approved ${r.approved}`)
    const left = await pool.query(`select count(*)::int as n from time_entries where client_id = $1`, [HOLDING_CLIENT])
    const sum = check.rows.reduce((s, r) => s + r.minutes, 0)
    console.log(`left on holding client: ${left.rows[0].n}; slice minutes total ${sum} vs original ${totalMinutes}`)
    console.log('COMMITTED')
  }
} catch (error) {
  console.error('FAILED', error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error)
  process.exitCode = 1
} finally {
  await pool.end()
  if (store.pool) await store.pool.end()
}
