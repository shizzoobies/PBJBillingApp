#!/usr/bin/env node
// Single-row Updates-tracker (feature_requests) write against production.
//
// This is the ONE production write with standing approval (HANDOFF §7, item 6):
// flipping a tracker item's status / dev notes / clarification fields, exactly
// as the app's own PATCH /api/feature-requests/:id would. It mirrors
// `updateFeatureRequest` in db/store.js: moving to `shipped` stamps
// `shipped_at = now()` and clears the review fields; moving to `done` stamps
// the approval; any other status clears the approval.
//
// It cannot touch any other table or more than one row. Keep it that way — the
// permission rule that lets a session run it unprompted depends on that.
//
// Usage (from the repo root, any shell):
//   node scripts/prod/tracker-update.mjs <featreq-id> [options]
//     --status <new|planned|planned_not_eom|in_progress|needs_input|brainstorm|shipped|done|wont_do>
//     --dev-notes "<text>"            prepend to the existing dev notes (default)
//     --dev-notes-file <path>         same, read from a file (long notes)
//     --replace-notes                 overwrite dev notes instead of prepending
//     --question "<text>"             set clarification_question ('' clears)
//     --answer "<text>"               set clarification_answer ('' clears)
//     --acting <user-id>              who the write is attributed to (default emp-alex-anderson)
//     --dry-run                       print the row and the planned change, write nothing
//
// The connection string comes from DATABASE_PUBLIC_URL (or DATABASE_URL) in
// the environment, else from `railway variables --service Postgres --json`.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import pg from 'pg'

const STATUSES = [
  'new',
  'planned',
  'planned_not_eom',
  'in_progress',
  'needs_input',
  'brainstorm',
  'shipped',
  'done',
  'wont_do',
]

function parseArgs(argv) {
  const out = { id: null, acting: 'emp-alex-anderson', dryRun: false, replaceNotes: false }
  const args = [...argv]
  while (args.length) {
    const a = args.shift()
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--replace-notes') out.replaceNotes = true
    else if (a === '--status') out.status = args.shift()
    else if (a === '--dev-notes') out.devNotes = args.shift()
    else if (a === '--dev-notes-file') out.devNotes = readFileSync(args.shift(), 'utf8')
    else if (a === '--question') out.question = args.shift()
    else if (a === '--answer') out.answer = args.shift()
    else if (a === '--acting') out.acting = args.shift()
    else if (!out.id && /^featreq-[0-9a-f]{8}$/.test(a)) out.id = a
    else throw new Error(`Unexpected argument: ${a}`)
  }
  if (!out.id) throw new Error('First argument must be the item id, e.g. featreq-0c2d4ce5')
  if (out.status !== undefined && !STATUSES.includes(out.status))
    throw new Error(`--status must be one of ${STATUSES.join(', ')}`)
  if (
    out.status === undefined &&
    out.devNotes === undefined &&
    out.question === undefined &&
    out.answer === undefined
  )
    throw new Error('Nothing to change: pass --status, --dev-notes, --question or --answer')
  return out
}

function connectionString() {
  const fromEnv = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL
  if (fromEnv) return fromEnv
  const out = execFileSync(
    'npx',
    ['@railway/cli@latest', 'variables', '--service', 'Postgres', '--json'],
    { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'inherit'] },
  )
  const url = JSON.parse(out).DATABASE_PUBLIC_URL
  if (!url) throw new Error('DATABASE_PUBLIC_URL missing from railway variables output')
  return url
}

const opts = parseArgs(process.argv.slice(2))
const pool = new pg.Pool({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } })

try {
  const before = await pool.query(
    `select id, title, status, priority, dev_notes, review_note, reviewed_by,
            clarification_question, clarification_answer, shipped_at, approved_by, updated_at
       from feature_requests where id = $1`,
    [opts.id],
  )
  if (before.rowCount !== 1) throw new Error(`No tracker row with id ${opts.id}`)
  const row = before.rows[0]
  console.log(`BEFORE ${row.id} "${row.title}"`)
  console.log(
    `  status=${row.status} priority=${row.priority} shipped_at=${row.shipped_at ? row.shipped_at.toISOString() : null}` +
      ` review_note=${row.review_note ? row.review_note.length + ' chars' : null}` +
      ` question=${row.clarification_question ? 'set' : null} answer=${row.clarification_answer ? 'set' : null}`,
  )

  let devNotes
  if (opts.devNotes !== undefined) {
    const fresh = opts.devNotes.trim()
    devNotes = opts.replaceNotes || !row.dev_notes ? fresh : `${fresh}\n\n--- earlier ---\n${row.dev_notes}`
    devNotes = devNotes.slice(0, 4000)
  }
  const question = opts.question === undefined ? undefined : opts.question.trim().slice(0, 2000) || null
  const answer = opts.answer === undefined ? undefined : opts.answer.trim().slice(0, 2000) || null

  console.log('PLANNED CHANGE')
  if (opts.status !== undefined) console.log(`  status: ${row.status} -> ${opts.status}`)
  if (devNotes !== undefined)
    console.log(`  dev_notes: ${opts.replaceNotes ? 'replace' : 'prepend'} (${devNotes.length} chars after)`)
  if (question !== undefined) console.log(`  clarification_question: ${question === null ? 'clear' : 'set'}`)
  if (answer !== undefined) console.log(`  clarification_answer: ${answer === null ? 'clear' : 'set'}`)
  if (opts.status === 'shipped') console.log('  (shipped: shipped_at = now(), review fields cleared)')

  if (opts.dryRun) {
    console.log('DRY RUN - nothing written')
  } else {
    const after = await pool.query(
      `update feature_requests
          set status = coalesce($2, status),
              dev_notes = coalesce($3, dev_notes),
              approved_by = case
                when $2 = 'done' then coalesce(approved_by, $4)
                when $2 is not null then null
                else approved_by
              end,
              approved_at = case
                when $2 = 'done' then coalesce(approved_at, now())
                when $2 is not null then null
                else approved_at
              end,
              review_note = case when $2 in ('shipped', 'done') then null else review_note end,
              reviewed_by = case when $2 in ('shipped', 'done') then null else reviewed_by end,
              reviewed_at = case when $2 in ('shipped', 'done') then null else reviewed_at end,
              clarification_question = case when $7::boolean then $5::text else clarification_question end,
              clarification_answer = case when $8::boolean then $6::text else clarification_answer end,
              shipped_at = case when $2 = 'shipped' then now() else shipped_at end,
              updated_at = now()
        where id = $1
      returning id, status, shipped_at, review_note, clarification_question, clarification_answer,
                length(dev_notes) as dev_notes_len, updated_at`,
      [
        opts.id,
        opts.status ?? null,
        devNotes ?? null,
        opts.acting,
        question ?? null,
        answer ?? null,
        question !== undefined,
        answer !== undefined,
      ],
    )
    const r = after.rows[0]
    console.log(`AFTER  ${r.id}`)
    console.log(
      `  status=${r.status} shipped_at=${r.shipped_at ? r.shipped_at.toISOString() : null}` +
        ` review_note=${r.review_note ? 'set' : null} question=${r.clarification_question ? 'set' : null}` +
        ` answer=${r.clarification_answer ? 'set' : null} dev_notes=${r.dev_notes_len} chars`,
    )
  }
} finally {
  await pool.end()
}
