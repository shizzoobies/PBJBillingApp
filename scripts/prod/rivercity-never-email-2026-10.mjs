#!/usr/bin/env node
// One approved production write (Alex, 2026-10-04 evening): Rivercity Appraisal
// Services (client-c1qdfpd) moves from the platform-invoicing opt-out to the new
// "Generate the invoice but never email it" switch, so its monthly invoice
// generates again and Mark reviewed stamps it Sent without an email
// (featreq-21d0bba8 answer 8). Writes a JSON snapshot of the row first.
//
//   node scripts/prod/rivercity-never-email-2026-10.mjs [--apply]
//
// Without --apply it prints the row and rolls back. The connection string comes
// from DATABASE_PUBLIC_URL (or DATABASE_URL).
//
// Undo: `update clients set platform_invoicing_opt_out = true, invoice_no_email = false,
//        updated_at = now() where id = 'client-c1qdfpd'` (the snapshot holds the prior values).

import { mkdirSync, writeFileSync } from 'node:fs'
import pg from 'pg'

const CLIENT_ID = 'client-c1qdfpd'
const apply = process.argv.includes('--apply')
const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_PUBLIC_URL (or DATABASE_URL) is required')
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 1 })
const client = await pool.connect()
try {
  const before = await client.query(
    `select id, name, platform_invoicing_opt_out, invoice_no_email, updated_at from clients where id = $1`,
    [CLIENT_ID],
  )
  if (before.rows.length !== 1) throw new Error(`client ${CLIENT_ID} not found`)
  console.log('BEFORE', JSON.stringify(before.rows[0]))
  if (before.rows[0].invoice_no_email === undefined) {
    throw new Error('clients.invoice_no_email does not exist yet - deploy first')
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  mkdirSync('docs/prod-snapshots', { recursive: true })
  const snapshotPath = `docs/prod-snapshots/${stamp}-rivercity-never-email-before.json`
  writeFileSync(snapshotPath, JSON.stringify(before.rows[0], null, 2) + '\n')
  console.log('snapshot', snapshotPath)

  await client.query('begin')
  await client.query(`set local lock_timeout = '2s'`)
  const after = await client.query(
    `update clients
        set platform_invoicing_opt_out = false, invoice_no_email = true, updated_at = now()
      where id = $1
      returning id, name, platform_invoicing_opt_out, invoice_no_email, updated_at`,
    [CLIENT_ID],
  )
  console.log('AFTER ', JSON.stringify(after.rows[0]))
  if (apply) {
    await client.query('commit')
    console.log('COMMITTED')
  } else {
    await client.query('rollback')
    console.log('ROLLED BACK (dry run; pass --apply to commit)')
  }
} catch (error) {
  try {
    await client.query('rollback')
  } catch {
    /* nothing to roll back */
  }
  console.error('FAILED', error.message)
  process.exitCode = 1
} finally {
  client.release()
  await pool.end()
}
