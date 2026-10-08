#!/usr/bin/env node
// Read-only: is production quiet enough to deploy? Prints the invoice counts for this
// month, how many invoices were sent in the last 15 minutes and touched in the last 5.
// Deploy only when "touched in last 5 min" is 0 (HANDOFF section 3). Run from the
// repo root with the Railway project linked (`railway link`), or set DATABASE_PUBLIC_URL.
import { execSync } from 'node:child_process'
import pg from 'pg'

function connectionString() {
  if (process.env.DATABASE_PUBLIC_URL) return process.env.DATABASE_PUBLIC_URL
  const raw = execSync('npx @railway/cli@latest variables --service Postgres --json', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return JSON.parse(raw).DATABASE_PUBLIC_URL
}

const pool = new pg.Pool({ connectionString: connectionString(), ssl: { rejectUnauthorized: false }, max: 1 })
try {
  const period = new Date().toISOString().slice(0, 7)
  const byStatus = await pool.query(
    `select status, count(*)::int as n from invoices where period = $1 group by 1 order by 1`,
    [period],
  )
  console.log(byStatus.rows.map((row) => `${period} ${row.status}=${row.n}`).join(' | ') || `${period}: no invoices`)
  const sent = await pool.query(
    `select count(*)::int as n, max(sent_at) as last from invoices where sent_at > now() - interval '15 minutes'`,
  )
  console.log('sent in last 15 min:', sent.rows[0].n, 'last sent_at:', sent.rows[0].last)
  const touched = await pool.query(
    `select count(*)::int as n, max(updated_at) as last, now() as now from invoices where updated_at > now() - interval '5 minutes'`,
  )
  console.log(
    'invoices touched in last 5 min:',
    touched.rows[0].n,
    'last:',
    touched.rows[0].last,
    'now:',
    new Date(touched.rows[0].now).toISOString(),
  )
  process.exitCode = touched.rows[0].n === 0 ? 0 : 1
} finally {
  await pool.end()
}
