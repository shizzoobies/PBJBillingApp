#!/usr/bin/env node
// Sets "Due on receipt" as the payment terms on every active client whose record says
// nothing a machine can read (blank) or says "Due on receipt" / "Due on Demand"
// / "Immediate" / a casing variant, and makes it the firm default for new clients.
//
// Why: Alex decided 2026-09-15 that every invoice is due 30 days after it is
// issued, and the client-facing invoice says "Due on receipt" (the 30 days are the
// firm's internal past-due line). This write makes the client records say what
// the invoices say, so the Clients page and the PDF agree.
//
//   node scripts/prod/set-payment-terms-due-on-receipt.mjs              dry run (rolled back)
//   node scripts/prod/set-payment-terms-due-on-receipt.mjs --apply      write it, snapshot first
//   node scripts/prod/set-payment-terms-due-on-receipt.mjs --undo docs/prod-snapshots/<stamp>-payment-terms-before-due-on-receipt.json [--apply]
//
// The snapshot (every active client's id, name, payment_terms, plus the firm
// client_defaults) is written to docs/prod-snapshots/ BEFORE the update and
// should be committed. Connection string: DATABASE_PUBLIC_URL / DATABASE_URL
// in the environment, else the Railway CLI.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Client } = require('pg')

const NEW_TERMS = 'Due on receipt'
const RESET_PATTERN = /receipt|demand|immediat/i

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const undoIndex = args.indexOf('--undo')
const undoPath = undoIndex >= 0 ? args[undoIndex + 1] : null

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

const db = new Client({ connectionString: connectionString(), ssl: { rejectUnauthorized: false } })

function shouldReset(terms) {
  const t = (terms ?? '').trim()
  return t === '' || RESET_PATTERN.test(t)
}

async function snapshotState() {
  const clients = await db.query(
    `select id, name, payment_terms, coalesce(lifecycle_stage, 'active') as lifecycle_stage
       from clients order by name`,
  )
  const firm = await db.query(`select client_defaults from firm_settings`)
  return {
    takenAt: new Date().toISOString(),
    clients: clients.rows.map((r) => ({
      id: r.id,
      name: r.name,
      paymentTerms: r.payment_terms,
      lifecycleStage: r.lifecycle_stage,
    })),
    firmClientDefaults: firm.rows.map((r) => r.client_defaults),
  }
}

async function forward() {
  const before = await snapshotState()
  const targets = before.clients.filter(
    (c) => c.lifecycleStage === 'active' && shouldReset(c.paymentTerms) && (c.paymentTerms ?? '').trim() !== NEW_TERMS,
  )
  console.log(`Active clients: ${before.clients.filter((c) => c.lifecycleStage === 'active').length}`)
  console.log(`Would set "${NEW_TERMS}" on ${targets.length}:`)
  for (const c of targets) console.log(`  ${c.name}: ${JSON.stringify(c.paymentTerms ?? null)} -> "${NEW_TERMS}"`)
  console.log(
    `Firm default terms: ${JSON.stringify(before.firmClientDefaults.map((d) => d?.paymentTerms ?? null))} -> "${NEW_TERMS}"`,
  )

  let snapshotPath = null
  if (apply) {
    const stamp = before.takenAt.replace(/[:.]/g, '-')
    snapshotPath = `docs/prod-snapshots/${stamp}-payment-terms-before-due-on-receipt.json`
    mkdirSync('docs/prod-snapshots', { recursive: true })
    writeFileSync(snapshotPath, JSON.stringify(before, null, 2) + '\n')
    console.log(`Snapshot written: ${snapshotPath}`)
  }

  await db.query('begin')
  const ids = targets.map((c) => c.id)
  const r1 = ids.length
    ? await db.query(
        `update clients set payment_terms = $2, updated_at = now() where id = any($1::text[])`,
        [ids, NEW_TERMS],
      )
    : { rowCount: 0 }
  const r2 = await db.query(
    `update firm_settings
        set client_defaults = coalesce(client_defaults, '{}'::jsonb) || jsonb_build_object('paymentTerms', $1::text)`,
    [NEW_TERMS],
  )
  const check = await db.query(
    `select count(*)::int as n from clients where id = any($1::text[]) and payment_terms = $2`,
    [ids, NEW_TERMS],
  )
  if (check.rows[0].n !== ids.length) throw new Error(`re-select mismatch: ${check.rows[0].n} of ${ids.length}`)
  if (apply) {
    await db.query('commit')
    console.log(`APPLIED: ${r1.rowCount} client rows, ${r2.rowCount} firm_settings row(s). Undo: --undo ${snapshotPath} --apply`)
  } else {
    await db.query('rollback')
    console.log(`DRY RUN: ${r1.rowCount} client rows and ${r2.rowCount} firm_settings row(s) would change. ROLLED BACK.`)
  }
}

async function undo() {
  const snap = JSON.parse(readFileSync(undoPath, 'utf8'))
  await db.query('begin')
  let restored = 0
  for (const c of snap.clients) {
    const r = await db.query(
      `update clients set payment_terms = $2, updated_at = now()
        where id = $1 and payment_terms is distinct from $2`,
      [c.id, c.paymentTerms],
    )
    if (r.rowCount) {
      restored += 1
      console.log(`  ${c.name}: -> ${JSON.stringify(c.paymentTerms ?? null)}`)
    }
  }
  const firmDefaults = snap.firmClientDefaults?.[0] ?? null
  const r2 = await db.query(`update firm_settings set client_defaults = $1::jsonb`, [
    firmDefaults === null ? null : JSON.stringify(firmDefaults),
  ])
  if (apply) {
    await db.query('commit')
    console.log(`RESTORED ${restored} client rows and ${r2.rowCount} firm_settings row(s) from ${undoPath}`)
  } else {
    await db.query('rollback')
    console.log(`DRY RUN: ${restored} client rows would be restored. ROLLED BACK.`)
  }
}

async function main() {
  await db.connect()
  try {
    if (undoPath) await undo()
    else await forward()
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error('ERR', error.message)
  process.exit(1)
})
