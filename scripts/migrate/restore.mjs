// Restore a dump made by dump.mjs into the TARGET (Neon) database.
//
//   $env:TARGET_DATABASE_URL = '<neon url, pooling OFF>'
//   node scripts/migrate/restore.mjs --file <dump> [--target-url-env NAME] [--force]
//
// Runs:  pg_restore --no-owner --no-privileges --exit-on-error --jobs 2
//                   -d <database name> <dump>
// Connection details travel as libpq environment variables; the URL is not in
// argv. --no-owner / --no-privileges mean no ALTER OWNER and no GRANT/REVOKE
// ever reaches Neon (which has no superuser and no `postgres` role to name).
//
// Safety: refuses unless the target has NO user relations (tables, partitioned
// tables, sequences, views, materialized views in any schema except the system
// ones and Neon's own `neon` / `neon_auth`), and refuses a Neon `-pooler` host
// (restore needs a direct connection). --force skips only the emptiness check. It never skips the identical-database check: if SOURCE_DATABASE_URL is
// also set and points at the same host:port/database, the restore is refused.

import { access } from 'node:fs/promises'
import { spawn as nodeSpawn } from 'node:child_process'
import path from 'node:path'
import {
  connectClient,
  describeTarget,
  isMain,
  isPoolerHost,
  lastLines,
  libpqEnv,
  parseArgs,
  pgBinary,
  readUrl,
  redact,
  runTool,
  sameDatabase,
  toolEnv,
} from './lib.mjs'

export const IGNORED_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast', 'neon', 'neon_auth']

export function restoreArgs(database, file) {
  return ['--no-owner', '--no-privileges', '--exit-on-error', '--jobs', '2', '-d', database, file]
}

/**
 * User relations currently in the target, as "schema.name" strings: ordinary and
 * partitioned tables, sequences, views and materialized views (pg_class kinds
 * r, p, S, v, m) outside the system and Neon-managed schemas.
 */
export async function userTables(client) {
  const { rows } = await client.query(
    `select n.nspname as relation_schema, c.relname as relation_name
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p', 'S', 'v', 'm')
        and n.nspname <> all ($1::text[])
        and n.nspname not like 'pg\\_temp\\_%'
        and n.nspname not like 'pg\\_toast\\_temp\\_%'
      order by 1, 2`,
    [IGNORED_SCHEMAS],
  )
  return rows.map((row) => `${row.relation_schema}.${row.relation_name}`)
}

export async function main(argv, env = process.env, deps = {}) {
  const log = deps.log || console.log
  const spawn = deps.spawn || nodeSpawn
  const connect = deps.connect || connectClient
  const platform = deps.platform || process.platform
  const fileExists = deps.access || access

  let parsed
  let target
  try {
    parsed = parseArgs(argv, { options: ['file', 'target-url-env'], flags: ['force'] })
    target = readUrl(env, parsed.options['target-url-env'], 'TARGET_DATABASE_URL')
  } catch (error) {
    log(`restore: ${error.message}`)
    return 2
  }
  if (!parsed.options.file) {
    log('restore: --file <dump> is required')
    return 2
  }
  const file = path.resolve(parsed.options.file)
  try {
    await fileExists(file)
  } catch {
    log(`restore: no such file ${file}`)
    return 2
  }

  let database
  try {
    database = libpqEnv(target.url).PGDATABASE
  } catch (error) {
    log(`restore: ${error.message}`)
    return 2
  }
  if (!database) {
    log(`restore: ${target.varName} has no database name (the /dbname part of the URL)`)
    return 2
  }

  if (isPoolerHost(target.url)) {
    log('restore: REFUSED - the target host is a Neon pooled (-pooler) endpoint. Use the DIRECT connection string (pooling off).')
    return 2
  }
  if (env.SOURCE_DATABASE_URL && sameDatabase(env.SOURCE_DATABASE_URL, target.url)) {
    log('restore: REFUSED - SOURCE_DATABASE_URL and the target are the same database')
    return 2
  }

  log(`restore: target ${describeTarget(target.url)} (from ${target.varName}); dump ${file}`)

  if (parsed.flags.force) {
    log('restore: --force given, skipping the empty-target check')
  } else {
    let tables
    const client = await connect(target.url)
    try {
      tables = await userTables(client)
    } finally {
      await client.end()
    }
    if (tables.length > 0) {
      log(`restore: REFUSED - the target already has ${tables.length} user relation(s): ${tables.slice(0, 5).join(', ')}${tables.length > 5 ? ', ...' : ''}`)
      log('restore: restore only into an EMPTY database. Create a fresh Neon branch/database, or pass --force if you really mean it.')
      return 2
    }
    log('restore: target is empty, proceeding')
  }

  const pgRestore = pgBinary('pg_restore', env, platform)
  const started = Date.now()
  let result
  try {
    result = await runTool(spawn, pgRestore, restoreArgs(database, file), toolEnv(env, target.url))
  } catch (error) {
    log(`restore: could not start ${pgRestore}: ${redact(error.message, [target.url])}. Set PG_BIN to the PostgreSQL 18 bin folder.`)
    return 1
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  log(`restore: pg_restore exit code ${result.code} after ${seconds}s`)
  const tail = lastLines(redact(result.stderr, [target.url]), 20)
  if (tail.length) {
    log('restore: last lines of pg_restore stderr:')
    for (const line of tail) log(`  ${line}`)
  }
  if (result.code !== 0) {
    log('restore: FAILED. Drop and recreate the target database before trying again (--exit-on-error stops half way).')
    return 1
  }

  // Fresh statistics so the first queries on the new database plan well.
  const client = await connect(target.url)
  try {
    await client.query('analyze')
  } finally {
    await client.end()
  }
  log('restore: OK (analyze done). Next: node scripts/migrate/boot-check.mjs, then verify.mjs')
  return 0
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`restore: ${error.message}`)
      process.exit(1)
    },
  )
}
