// Run the app's own boot DDL against the restored target BEFORE the first
// deploy, so any DDL failure shows up here and not in a container that will not
// start.
//
//   $env:TARGET_DATABASE_URL = '<neon url, pooling OFF>'
//   node scripts/migrate/boot-check.mjs [--target-url-env NAME] [--allow-empty] [--allow-railway]
//
// What it runs: `new AppDataStore().initialize()` from db/store.js with
// DATABASE_URL pointed at the target. What it does NOT run:
// `applyOwnerBootstrapPassword()` - that is called from server.js (line ~19605)
// at startup, NOT from initialize(), so this script cannot set a password.
//
// "Never writes data" - what that means precisely. initialize() is idempotent
// DDL (create ... if not exists, add column if not exists, indexes) PLUS a few
// guarded data steps: seed demo users/clients ONLY into an empty database,
// backfills that only touch rows still NULL, and the OWNER_EMAIL / ADMIN_EMAIL
// user sync. This script therefore:
//   * refuses an empty target (initialize would seed demo data) unless
//     --allow-empty;
//   * clears OWNER_EMAIL and ADMIN_EMAIL for the run so the email sync is off;
//   * counts inserts/updates/deletes per table (pg_stat_user_tables) before and
//     after, and exits 3 if ANY pre-existing table changed. New tables created
//     by the DDL are listed, with the rows (if any) the app seeded into them.
// Exit 0 = DDL landed, no existing data touched. 1 = initialize() threw (the
// message is printed). 2 = refused to run. 3 = existing data changed.

import { isMain, isPoolerHost, connectClient, describeTarget, parseArgs, readUrl, redact, sameDatabase } from './lib.mjs'

const RAILWAY_HOST = /(^|\.)(rlwy\.net|railway\.app|railway\.internal)$/i

async function loadRealStore(url) {
  process.env.DATABASE_URL = url
  delete process.env.OWNER_EMAIL
  delete process.env.ADMIN_EMAIL
  const { AppDataStore } = await import('../../db/store.js')
  return new AppDataStore()
}

async function tableStats(client) {
  await client.query('select pg_stat_clear_snapshot()')
  const { rows } = await client.query(
    `select relname, n_tup_ins::text as ins, n_tup_upd::text as upd, n_tup_del::text as del
       from pg_stat_user_tables where schemaname = 'public'`,
  )
  const stats = new Map()
  for (const row of rows) {
    stats.set(row.relname, { ins: Number(row.ins), upd: Number(row.upd), del: Number(row.del) })
  }
  return stats
}

/** Pure: what changed between two stat snapshots. */
export function diffStats(before, after) {
  const created = []
  const changed = []
  for (const [table, now] of after) {
    const was = before.get(table)
    if (!was) {
      created.push({ table, inserted: now.ins })
      continue
    }
    const delta = { ins: now.ins - was.ins, upd: now.upd - was.upd, del: now.del - was.del }
    if (delta.ins || delta.upd || delta.del) changed.push({ table, ...delta })
  }
  return { created, changed }
}

export async function main(argv, env = process.env, deps = {}) {
  const log = deps.log || console.log
  const connect = deps.connect || connectClient
  const loadStore = deps.loadStore || loadRealStore
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))

  let parsed
  let target
  try {
    parsed = parseArgs(argv, { options: ['target-url-env'], flags: ['allow-empty', 'allow-railway'] })
    target = readUrl(env, parsed.options['target-url-env'], 'TARGET_DATABASE_URL')
  } catch (error) {
    log(`boot-check: ${error.message}`)
    return 2
  }

  let description
  try {
    description = describeTarget(target.url)
  } catch (error) {
    log(`boot-check: ${error.message}`)
    return 2
  }
  const host = description.split(':')[0]
  if (env.SOURCE_DATABASE_URL && sameDatabase(env.SOURCE_DATABASE_URL, target.url)) {
    log('boot-check: REFUSED - the target is the same database as SOURCE_DATABASE_URL')
    return 2
  }
  if (isPoolerHost(target.url)) {
    log('boot-check: REFUSED - the target host is a Neon pooled (-pooler) endpoint. Use the DIRECT connection string (pooling off).')
    return 2
  }
  if (RAILWAY_HOST.test(host) && !parsed.flags['allow-railway']) {
    log(`boot-check: REFUSED - ${host} looks like Railway. This script is for the Neon copy; pass --allow-railway only if you mean it.`)
    return 2
  }
  log(`boot-check: target ${description} (from ${target.varName})`)

  const probe = await connect(target.url)
  let before
  try {
    const usersTable = await probe.query(`select to_regclass('public.users') is not null as present`)
    let users = 0
    if (usersTable.rows[0].present) {
      users = Number((await probe.query('select count(*)::text as n from public.users')).rows[0].n)
    }
    if (users === 0 && !parsed.flags['allow-empty']) {
      log('boot-check: REFUSED - the target has no users. initialize() would seed the demo users and clients into an empty database.')
      log('boot-check: restore the dump first (restore.mjs), or pass --allow-empty to build an empty schema on purpose.')
      return 2
    }
    before = await tableStats(probe)
  } finally {
    await probe.end()
  }

  const captured = []
  const original = { log: console.log, warn: console.warn, error: console.error }
  const capture = (level) => (...args) => captured.push({ level, text: args.map(String).join(' ') })
  let failure = null
  const store = await loadStore(target.url)
  console.log = capture('log')
  console.warn = capture('warn')
  console.error = capture('error')
  try {
    await store.initialize()
  } catch (error) {
    failure = error
  } finally {
    console.log = original.log
    console.warn = original.warn
    console.error = original.error
    try {
      await store.pool?.end()
    } catch {
      /* the pool is closing; nothing useful to report */
    }
  }

  await sleep(1500) // Postgres flushes per-table counters about once a second.
  const after = await connect(target.url)
  let tables
  let stats
  try {
    tables = Number(
      (await after.query(`select count(*)::text as n from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`)).rows[0].n,
    )
    stats = await tableStats(after)
  } finally {
    await after.end()
  }

  const { created, changed } = diffStats(before, stats)
  log(`boot-check: public tables now ${tables} (was ${before.size})`)
  if (created.length) {
    log(`boot-check: created by the boot DDL (${created.length}): ${created.map((c) => (c.inserted ? `${c.table} [${c.inserted} seeded]` : c.table)).join(', ')}`)
  }
  const problems = captured.filter((entry) => entry.level === 'warn' || entry.level === 'error')
  if (problems.length) {
    log(`boot-check: initialize() logged ${problems.length} warning(s)/error(s) - read them:`)
    for (const entry of problems) log(`  [${entry.level}] ${redact(entry.text, [target.url])}`)
  }
  if (failure) {
    log(`boot-check: DDL FAILED - ${redact(failure.message || String(failure), [target.url])}`)
    return 1
  }
  if (changed.length) {
    log('boot-check: EXISTING DATA CHANGED during initialize():')
    for (const row of changed) log(`  ${row.table}: +${row.ins} inserted, ${row.upd} updated, ${row.del} deleted`)
    return 3
  }
  log('boot-check: OK - the boot DDL ran clean and no existing table was modified')
  return 0
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`boot-check: ${error.message}`)
      process.exit(1)
    },
  )
}
