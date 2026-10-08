#!/usr/bin/env node
// Read-only: the open Updates-tracker items (feature_requests), one line each.
// Usage: node scripts/prod/tracker-list.mjs            (new, planned, in_progress, needs_input, planned_not_eom)
//        node scripts/prod/tracker-list.mjs --all      (every status)
// Needs the Railway project linked, or DATABASE_PUBLIC_URL.
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

const all = process.argv.includes('--all')
const open = ['new', 'planned', 'in_progress', 'needs_input', 'planned_not_eom', 'brainstorm']
const pool = new pg.Pool({ connectionString: connectionString(), ssl: { rejectUnauthorized: false }, max: 1 })
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
