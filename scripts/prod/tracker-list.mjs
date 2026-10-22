#!/usr/bin/env node
// Read-only: the open Updates-tracker items (feature_requests), one line each.
// Usage: node scripts/prod/tracker-list.mjs            (new, planned, in_progress, needs_input, planned_not_eom)
//        node scripts/prod/tracker-list.mjs --all      (every status)
// Uses PROD_DATABASE_URL from the environment or PBJ_PROD_ENV_FILE.
import { prodEnv, prodDatabaseUrl } from './env.mjs'
import pg from 'pg'

function connectionString() {
  return prodDatabaseUrl(prodEnv(['PROD_DATABASE_URL']).PROD_DATABASE_URL)
}

const all = process.argv.includes('--all')
const open = ['new', 'planned', 'in_progress', 'needs_input', 'planned_not_eom', 'brainstorm']
const pool = new pg.Pool({ connectionString: connectionString(), ssl: { rejectUnauthorized: true }, max: 1 })
try {
  const result = await pool.query(
    `select id, status, type, priority, title, clarification_question, clarification_answer, updated_at
       from feature_requests
      ${all ? '' : 'where status = any($1::text[])'}
      order by case status when 'planned' then 0 when 'in_progress' then 1 when 'needs_input' then 2 when 'new' then 3 else 4 end, updated_at desc`,
    all ? [] : [open],
  )
  for (const row of result.rows) {
    const answered = row.clarification_answer ? ' [ANSWERED]' : row.clarification_question ? ' [asked]' : ''
    console.log(`${row.status.padEnd(16)} ${row.id}${answered}  | ${String(row.title).slice(0, 110)}`)
  }
  console.log(`${result.rowCount} item(s)`)
} finally {
  await pool.end()
}
