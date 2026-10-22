#!/usr/bin/env node
// Read-only: is production quiet enough to deploy? Prints the invoice counts for this
// month, how many invoices were sent in the last 15 minutes and touched in the last 5.
// Deploy only when "touched in last 5 min" is 0 (HANDOFF section 3). Run from the
// repo root with PROD_DATABASE_URL in the environment or PBJ_PROD_ENV_FILE.
import { prodEnv, prodDatabaseUrl } from './env.mjs'
import pg from 'pg'

function connectionString() {
  return prodDatabaseUrl(prodEnv(['PROD_DATABASE_URL']).PROD_DATABASE_URL)
}

const pool = new pg.Pool({ connectionString: connectionString(), ssl: { rejectUnauthorized: true }, max: 1 })
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
