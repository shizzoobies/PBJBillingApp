#!/usr/bin/env node
/**
 * Undo for reset-team-lists-2026-09.mjs: puts every client's
 * `assigned_bookkeeper_ids` back to what the snapshot recorded.
 *
 *   npx @railway/cli@latest variables --service Postgres --json \
 *     | node scripts/prod/restore-team-lists.mjs docs/prod-snapshots/<stamp>-team-lists-before-reset.json [--apply]
 *
 * Without --apply it prints what it would restore and rolls back.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Client } = require('pg')

const [snapshotPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const apply = process.argv.includes('--apply')
if (!snapshotPath) {
  console.error('usage: restore-team-lists.mjs <snapshot.json> [--apply]')
  process.exit(1)
}
const vars = JSON.parse(readFileSync(0, 'utf8'))
const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))

const db = new Client({
  connectionString: vars.DATABASE_PUBLIC_URL,
  ssl: { rejectUnauthorized: false },
})

async function main() {
  await db.connect()
  await db.query('begin')
  let restored = 0
  for (const entry of snapshot) {
    const r = await db.query(
      `update clients set assigned_bookkeeper_ids = $2, updated_at = now()
        where id = $1 and assigned_bookkeeper_ids is distinct from $2::text[]`,
      [entry.id, entry.assignedBookkeeperIds ?? []],
    )
    if (r.rowCount) {
      restored += 1
      console.log(`${entry.name}: -> [${(entry.assignedBookkeeperIds ?? []).join(', ')}]`)
    }
  }
  if (apply) {
    await db.query('commit')
    console.log(`RESTORED ${restored} client rows from ${snapshotPath}`)
  } else {
    await db.query('rollback')
    console.log(`DRY RUN: ${restored} rows would be restored. ROLLED BACK.`)
  }
  await db.end()
}

main().catch((error) => {
  console.error('ERR', error.message)
  process.exit(1)
})
