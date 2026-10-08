#!/usr/bin/env node
// Read-only: the full text of the tracker items named on the command line.
// Usage: node scripts/prod/tracker-read.mjs featreq-xxxxxxxx [featreq-yyyyyyyy ...]
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

const ids = process.argv.slice(2).filter((arg) => !arg.startsWith('--'))
if (ids.length === 0) {
  console.error('pass one or more featreq ids')
  process.exit(2)
}
const pool = new pg.Pool({ connectionString: connectionString(), ssl: { rejectUnauthorized: false }, max: 1 })
try {
  const result = await pool.query(`select * from feature_requests where id = any($1::text[])`, [ids])
  for (const id of ids) {
    const row = result.rows.find((entry) => entry.id === id)
    if (!row) {
      console.log(`\n=== ${id}: not found`)
      continue
    }
    console.log(`\n=== ${row.id} [${row.status}/${row.type}/${row.priority}] updated ${row.updated_at ? new Date(row.updated_at).toISOString() : "-"} "${row.title}"`)
    console.log('DESCRIPTION:', String(row.description ?? ''))
    if (row.review_note) console.log('REVIEW NOTE:', row.review_note)
    if (row.clarification_question) console.log('QUESTION:', row.clarification_question)
    if (row.clarification_answer) console.log('ANSWER:', row.clarification_answer)
    if (row.dev_notes) console.log('DEV NOTES:', String(row.dev_notes))
  }
} finally {
  await pool.end()
}
