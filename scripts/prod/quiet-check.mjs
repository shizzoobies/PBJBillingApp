#!/usr/bin/env node
// Read-only: is production quiet enough to deploy? Prints the invoice counts for this
// month, how many invoices were sent in the last 15 minutes and touched in the last 5.
// Deploy only when nothing was sent in the last 15 minutes and nothing but a bulk save
// touched an invoice in the last 5 (HANDOFF section 3). Run from the
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
  // A bulk save (every page save) rewrites EVERY invoice row with one updated_at value, so
  // "touched" used to trip on Brittany merely working (2026-10-27). A burst that stamps
  // most invoices in one instant is that bulk save, not invoicing: report it and ignore it.
  // Anything else touched in the last 5 minutes, or anything SENT in the last 15, is not quiet.
  const total = await pool.query(`select count(*)::int as n from invoices`)
  const touched = await pool.query(
    `select updated_at, count(*)::int as n from invoices where updated_at > now() - interval '5 minutes' group by updated_at order by n desc`,
  )
  const now = (await pool.query(`select now() as now`)).rows[0].now
  const isBulk = (row) => row.n >= 20 && row.n * 2 >= total.rows[0].n
  const bulk = touched.rows.filter(isBulk)
  const real = touched.rows.filter((row) => !isBulk(row))
  const realCount = real.reduce((sum, row) => sum + row.n, 0)
  for (const row of bulk) {
    console.log(`bulk save at ${new Date(row.updated_at).toISOString()} stamped ${row.n} of ${total.rows[0].n} invoices (ignored)`)
  }
  console.log(
    'invoices touched in last 5 min (excluding bulk saves):',
    realCount,
    'last:',
    real[0]?.updated_at ?? null,
    'now:',
    new Date(now).toISOString(),
  )
  process.exitCode = realCount === 0 && sent.rows[0].n === 0 ? 0 : 1
} finally {
  await pool.end()
}
