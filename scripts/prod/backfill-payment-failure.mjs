#!/usr/bin/env node
/**
 * One-off: put a payment failure that happened BEFORE the log write existed
 * onto an invoice's `email_log`, so the month run's "Payment failed" tab shows
 * it.
 *
 * Since 2026-09 the Stripe webhook calls `recordInvoicePaymentFailure`
 * (db/store.js), which appends `{kind:'payment', event:'failed', at,
 * paymentIntentId, detail}` to the invoice's append-only `email_log`; the tab
 * derives from that entry (`unresolvedPaymentFailure`, src/lib/utils.ts).
 * Failures from before that code shipped left NO entry — the invoice went back
 * to `sent` and reads as if nobody ever tried. This writes the missing entry,
 * and only that entry: same shape, same SQL, no status write, no notification,
 * no other column.
 *
 * Nothing has to be typed in. Production already holds both facts: the failure
 * time and the Stripe reason are in the `invoice_payment_failed` notification
 * the webhook sent the owners ("Payment failed on invoice <number> [to
 * <client>] — <reason>"); the earliest such row for the invoice is the failure.
 * `--at` / `--detail` override that when the notification is gone.
 *
 *   npx @railway/cli@latest variables --service Postgres --json \
 *     | node scripts/prod/backfill-payment-failure.mjs INV-2026-08-031 [--apply] \
 *         [--at <ISO>] [--detail "<reason>"] [--force]
 *
 * Without --apply it prints the whole preview and ROLLS BACK. With --apply it
 * writes a snapshot of the pre-write log to docs/prod-snapshots/ FIRST (the
 * handoff rule is snapshot-before-write — HANDOFF §4) and then commits.
 *
 * UNDO — puts `email_log` back to exactly what the snapshot recorded:
 *
 *   npx @railway/cli@latest variables --service Postgres --json \
 *     | node scripts/prod/backfill-payment-failure.mjs --undo docs/prod-snapshots/<file>.json [--apply]
 *
 * The undo refuses unless the log is still the snapshot's log plus the one
 * `kind:'payment'` entry this script added — if anything else has landed since,
 * it stops and says so rather than clobbering it.
 *
 * Idempotent, and safe to run twice: an invoice that already carries a payment
 * entry for its intent prints "already logged" and writes nothing.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { Client } = require('pg')

const USAGE =
  'usage: ... variables --json | node scripts/prod/backfill-payment-failure.mjs <INVOICE-NUMBER> [--apply] [--at <ISO>] [--detail "<reason>"] [--force]\n' +
  '   or: ... variables --json | node scripts/prod/backfill-payment-failure.mjs --undo <snapshot.json> [--apply]'

// The store's statement, character for character (db/store.js,
// `recordInvoicePaymentFailure`). Appended in SQL, not read-modify-write, and
// `status` is deliberately absent.
const APPEND_SQL = `update invoices
            set email_log = coalesce(email_log, '[]'::jsonb) || $2::jsonb,
                updated_at = now()
          where id = $1`

const EM_DASH = ' — '
const REFUSED_STATUSES = {
  void: 'the invoice is void — a backfilled failure would never be shown, and would claim a payment was attempted on a cancelled invoice.',
  paid: 'the invoice is paid — logging a failure on it would contradict a settled payment.',
  processing:
    'the invoice is processing — a payment is in flight right now; wait for it to settle or fail on its own.',
  draft: 'the invoice is a draft — a payment failure implies it was sent.',
  reviewed: 'the invoice is reviewed but not sent — a payment failure implies it was sent.',
}

function parseArgs(argv) {
  const out = { positional: [], apply: false, force: false, at: null, detail: null, undo: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') out.apply = true
    else if (arg === '--force') out.force = true
    else if (arg === '--at') out.at = argv[(i += 1)] ?? null
    else if (arg === '--detail') out.detail = argv[(i += 1)] ?? null
    else if (arg === '--undo') out.undo = argv[(i += 1)] ?? null
    else if (arg.startsWith('--')) {
      console.error(`unknown flag: ${arg}\n${USAGE}`)
      process.exit(1)
    } else out.positional.push(arg)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const vars = JSON.parse(readFileSync(0, 'utf8'))
if (!vars.DATABASE_PUBLIC_URL) {
  console.error('DATABASE_PUBLIC_URL missing from stdin JSON')
  process.exit(1)
}

const db = new Client({
  connectionString: vars.DATABASE_PUBLIC_URL,
  ssl: { rejectUnauthorized: false },
})

const stamp = new Date().toISOString().replace(/[:.]/g, '-')

/** `email_log` is jsonb; pg hands it back parsed, but it can be null. */
function logArray(value) {
  return Array.isArray(value) ? value : []
}

function isPaymentEntry(entry) {
  return entry?.kind === 'payment'
}

/**
 * `latestInvoiceSend` (src/lib/utils.ts), re-implemented: a successful INVOICE
 * send is `ok` and carries no `kind` (delivery and payment events both do), and
 * it is the LAST such entry in array order — not the newest `at`.
 */
function latestInvoiceSend(log) {
  const sends = log.filter((entry) => entry?.ok === true && !entry?.kind)
  return sends.length > 0 ? sends[sends.length - 1] : null
}

/** `formatSentOn` (src/lib/utils.ts): "Sep 10", or "Sep 10, 2025" off-year. */
function formatSentOn(iso) {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return ''
  const thisYear = parsed.getFullYear() === new Date().getFullYear()
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...(thisYear ? {} : { year: 'numeric' }),
  }).format(parsed)
}

function refuse(message) {
  console.error(`REFUSING: ${message}`)
  process.exit(1)
}

async function lockInvoice(id) {
  const { rows } = await db.query(
    `select id, number, status, stripe_payment_intent_id, email_log
       from invoices where id = $1 for update`,
    [id],
  )
  return rows[0] ?? null
}

async function finish(apply, appliedLine, dryLine) {
  if (apply) {
    await db.query('commit')
    console.log(appliedLine)
  } else {
    await db.query('rollback')
    console.log(dryLine)
  }
}

/**
 * The failure time and reason as production recorded them: the EARLIEST
 * `invoice_payment_failed` notification for this invoice number. Both message
 * shapes are accepted — older rows read "... invoice <number> — <reason>",
 * newer ones "... invoice <number> to <client> — <reason>" — and the prefix
 * match is confirmed in JS so INV-...-031 cannot pick up INV-...-0310's row.
 */
async function findFailureNotification(number) {
  const { rows } = await db.query(
    `select id, message, created_at
       from notifications
      where event = 'invoice_payment_failed'
        and message like 'Payment failed on invoice ' || $1 || '%'
      order by created_at asc, id asc`,
    [number],
  )
  const prefix = `Payment failed on invoice ${number}`
  for (const row of rows) {
    const rest = String(row.message).slice(prefix.length)
    if (!rest.startsWith(EM_DASH) && !rest.startsWith(' to ')) continue
    const dashAt = String(row.message).indexOf(EM_DASH)
    if (dashAt === -1) continue
    return {
      id: row.id,
      createdAt: new Date(row.created_at).toISOString(),
      reason: String(row.message).slice(dashAt + EM_DASH.length).trim(),
      message: String(row.message),
    }
  }
  return null
}

async function backfill() {
  const [number] = args.positional
  if (!number) {
    console.error(USAGE)
    process.exit(1)
  }
  if (args.at !== null && Number.isNaN(new Date(args.at).getTime())) {
    refuse(`--at ${args.at} is not a date I can parse. Pass an ISO timestamp.`)
  }

  const { rows } = await db.query(
    `select i.id, i.number, i.status, i.stripe_payment_intent_id, i.email_log, i.client_id,
            c.name as client_name
       from invoices i left join clients c on c.id = i.client_id
      where i.number = $1`,
    [number],
  )
  if (rows.length === 0) {
    console.error(`No invoice with number ${number}.`)
    process.exit(1)
  }
  if (rows.length > 1) {
    refuse(`${rows.length} invoices carry the number ${number} — look before writing.`)
  }
  const invoice = rows[0]
  const log = logArray(invoice.email_log)
  const intentId = invoice.stripe_payment_intent_id ?? null

  const blocked = REFUSED_STATUSES[invoice.status]
  if (blocked) {
    console.error(`REFUSING: ${blocked} (${invoice.number} is '${invoice.status}')`)
    process.exit(1)
  }
  if (invoice.status !== 'sent' && invoice.status !== 'overdue') {
    refuse(
      `status '${invoice.status}' is not one the Payment failed tab reads (it shows only 'sent' and 'overdue').`,
    )
  }

  // Idempotent, on the same key the store uses: the intent id, or — when the
  // row has no intent id to match on — any payment entry at all.
  const existing = log.find(
    (entry) =>
      isPaymentEntry(entry) &&
      (intentId === null || (entry?.paymentIntentId ?? null) === intentId),
  )
  if (existing) {
    console.log(`already logged — ${invoice.number} already carries a payment entry:`)
    console.log(JSON.stringify(existing, null, 2))
    console.log('Nothing written.')
    return
  }

  let resolvedAt = null
  let atSource = ''
  let detail = null
  let detailSource = ''
  const notification = await findFailureNotification(invoice.number)
  if (args.at !== null) {
    resolvedAt = new Date(args.at).toISOString()
    atSource = '--at'
  } else if (notification) {
    resolvedAt = notification.createdAt
    atSource = `notification ${notification.id} (created_at ${notification.createdAt})`
  }
  if (args.detail !== null) {
    detail = args.detail
    detailSource = '--detail'
  } else if (notification) {
    detail = notification.reason
    detailSource = `notification ${notification.id} (text after the em dash)`
  }
  if (resolvedAt === null || detail === null) {
    refuse(
      `no 'invoice_payment_failed' notification for ${invoice.number} survives, so the failure time and reason cannot be recovered. Re-run with BOTH --at <ISO> and --detail "<reason>".`,
    )
  }
  detail = String(detail).slice(0, 300)

  console.log(`invoice:   ${invoice.number} (${invoice.id})`)
  console.log(`client:    ${invoice.client_name ?? '(unknown)'}`)
  console.log(`status:    ${invoice.status}   (not touched by this script)`)
  console.log(`at:        ${resolvedAt}   <- ${atSource}`)
  console.log(`detail:    ${detail}`)
  console.log(`           <- ${detailSource}`)
  console.log(`intent:    ${intentId ?? '(null)'}`)
  if (intentId === null) {
    console.log(
      '  WARNING: invoices.stripe_payment_intent_id is null, so the entry will carry no intent id.',
    )
  }
  if (notification) console.log(`notice:    "${notification.message}"`)
  console.log(`email_log: ${log.length} existing entr${log.length === 1 ? 'y' : 'ies'}`)
  console.log(`the tab will read: Payment failed ${formatSentOn(resolvedAt)} ${EM_DASH.trim()} ${detail}`)

  // The derived rule (`unresolvedPaymentFailure`): a successful send at or
  // after the failure answers it, and the invoice drops out of the tab.
  const send = latestInvoiceSend(log)
  if (send && String(send.at) >= resolvedAt) {
    console.log('')
    console.log(
      `  WARNING: the last successful send in the log is ${send.at}, at or after the failure — the` +
        ' invoice will NOT appear in the Payment failed tab (a re-send resolves a failure).',
    )
    if (!args.force) {
      refuse('re-run with --force if you want the entry written anyway.')
    }
    console.log('  --force given: writing it anyway.')
  }

  const entry = {
    kind: 'payment',
    event: 'failed',
    at: resolvedAt,
    paymentIntentId: intentId,
    detail,
  }
  console.log(`\nentry to append:\n${JSON.stringify(entry, null, 2)}\n`)

  await db.query('begin')
  const locked = await lockInvoice(invoice.id)
  if (!locked) {
    await db.query('rollback')
    refuse(`invoice ${invoice.id} disappeared between the read and the lock.`)
  }
  const lockedLog = logArray(locked.email_log)
  if (
    lockedLog.some(
      (e) => isPaymentEntry(e) && (intentId === null || (e?.paymentIntentId ?? null) === intentId),
    )
  ) {
    await db.query('rollback')
    console.log('already logged — a payment entry landed between the read and the lock. Nothing written.')
    return
  }

  // Snapshot BEFORE the update, never in a dry run — the snapshot is the undo,
  // and a dry run has nothing to undo.
  let snapshotPath = null
  if (args.apply) {
    mkdirSync('docs/prod-snapshots', { recursive: true })
    snapshotPath = `docs/prod-snapshots/${stamp}-${invoice.number}-email-log-before-payment-failure-backfill.json`
    writeFileSync(
      snapshotPath,
      JSON.stringify(
        {
          invoiceId: locked.id,
          number: locked.number,
          status: locked.status,
          emailLog: lockedLog,
          writtenAt: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
    )
    console.log(`snapshot: ${snapshotPath}`)
  }

  const { rowCount } = await db.query(APPEND_SQL, [invoice.id, JSON.stringify([entry])])
  if (rowCount !== 1) {
    await db.query('rollback')
    refuse(`the append touched ${rowCount} rows, expected 1. ROLLED BACK.`)
  }

  const after = (await db.query(
    `select status, email_log from invoices where id = $1`,
    [invoice.id],
  )).rows[0]
  const afterLog = logArray(after.email_log)
  console.log(`\nafter: status ${after.status} (was ${locked.status}), ${afterLog.length} log entries`)
  console.log(`last entry:\n${JSON.stringify(afterLog[afterLog.length - 1], null, 2)}`)

  await finish(
    args.apply,
    `\nAPPLIED: ${invoice.number} now carries the payment failure. Undo: node scripts/prod/backfill-payment-failure.mjs --undo ${snapshotPath} --apply`,
    '\nDRY RUN: the entry above would be appended. ROLLED BACK. Re-run with --apply to write.',
  )
}

async function undo() {
  const snapshot = JSON.parse(readFileSync(args.undo, 'utf8'))
  const snapLog = logArray(snapshot.emailLog)
  console.log(`snapshot:  ${args.undo}`)
  console.log(`invoice:   ${snapshot.number} (${snapshot.invoiceId})`)
  console.log(`taken at:  ${snapshot.writtenAt ?? '(unrecorded)'} with ${snapLog.length} log entries`)

  await db.query('begin')
  const locked = await lockInvoice(snapshot.invoiceId)
  if (!locked) {
    await db.query('rollback')
    refuse(`no invoice ${snapshot.invoiceId} — nothing to restore.`)
  }
  const currentLog = logArray(locked.email_log)

  // Only ever undo THIS script's write: the snapshot's log, plus exactly one
  // trailing payment entry. Anything else means something landed since, and
  // restoring would throw it away.
  const trailing = currentLog[currentLog.length - 1]
  const unchangedHead =
    JSON.stringify(currentLog.slice(0, snapLog.length)) === JSON.stringify(snapLog)
  if (currentLog.length !== snapLog.length + 1 || !isPaymentEntry(trailing) || !unchangedHead) {
    await db.query('rollback')
    refuse(
      `the log on ${locked.number} is not the snapshot's ${snapLog.length} entries plus one payment entry` +
        ` (it has ${currentLog.length} now). Something else has written to it since — look at the row` +
        ' before restoring anything. Nothing written.',
    )
  }

  const { rowCount } = await db.query(
    `update invoices set email_log = $2::jsonb, updated_at = now() where id = $1`,
    [snapshot.invoiceId, JSON.stringify(snapLog)],
  )
  if (rowCount !== 1) {
    await db.query('rollback')
    refuse(`the restore touched ${rowCount} rows, expected 1. ROLLED BACK.`)
  }

  const after = (await db.query(
    `select status, email_log from invoices where id = $1`,
    [snapshot.invoiceId],
  )).rows[0]
  const afterLog = logArray(after.email_log)
  console.log(
    `entries: ${currentLog.length} before -> ${afterLog.length} after (snapshot had ${snapLog.length})`,
  )
  console.log(`status:  ${after.status} (was ${locked.status}, not touched)`)
  console.log(`removed:\n${JSON.stringify(trailing, null, 2)}`)

  await finish(
    args.apply,
    `\nRESTORED: ${locked.number} email_log is back to ${args.undo}.`,
    '\nDRY RUN: the entry above would be removed. ROLLED BACK. Re-run with --apply to write.',
  )
}

async function main() {
  await db.connect()
  try {
    if (args.undo) await undo()
    else await backfill()
  } finally {
    await db.end()
  }
}

main().catch((error) => {
  console.error('ERR', error.message)
  process.exit(1)
})
