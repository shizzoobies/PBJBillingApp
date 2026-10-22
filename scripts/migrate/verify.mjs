// Compare the source and the restored target, table by table.
//
//   $env:SOURCE_DATABASE_URL = (Get-Content '<secrets>\railway-source.url' -Raw).Trim()
//   $env:TARGET_DATABASE_URL = (Get-Content '<secrets>\neon-target.url' -Raw).Trim()
//   node scripts/migrate/verify.mjs [--allow-missing signature_requests,...]
//
// For EVERY table in `public` on either side: row count; max(updated_at) and
// max(created_at) where the column exists; and a FULL-ROW hash,
//   md5(string_agg(md5(row::text), '' order by <primary key as text> collate "C"))
// computed inside Postgres (a table without a primary key orders by the row
// hash itself, so it is still compared by full rows). For the 12 largest tables
// there is also a sha256 over the ordered primary keys. Ordering is by text in
// the "C" collation, so a different default collation on the two servers can
// never fake a mismatch, and both sessions pin timezone=UTC, datestyle=ISO,
// extra_float_digits=3 and bytea_output=hex so the text form of a row is the
// same on both sides. Also prints a size estimate per side.
// Exits 1 on ANY mismatch. Run it while the app is stopped: a live source keeps
// changing under the comparison. Needs DIRECT connections (a Neon -pooler host
// is refused: session settings do not stick through PgBouncer).
//
// If the target has extra columns the source lacks (the boot DDL added them to a
// dump older than the code), that table's row hash is skipped and said so; a
// column the target LACKS is a mismatch. The authoritative data comparison is
// therefore the run BEFORE boot-check; run it again afterwards with
// --allow-missing for the counts and the tables the DDL created.
//
// --allow-missing a,b : tables the app's boot DDL creates on first boot. If the
// dump predates them they are ABSENT on the source (that is how a predating
// dump shows up: the table is on the target after boot-check but not on the
// source, or on neither before boot-check). An allowed table may be absent on
// either side; if it exists on only one side it must hold 0 rows.

import { connectClient, describeTarget, formatBytes, isMain, isPoolerHost, parseArgs, quoteIdent, readUrl, sameDatabase } from './lib.mjs'

const HASH_TABLE_LIMIT = 12
const TIMESTAMP_TYPES = new Set(['timestamp with time zone', 'timestamp without time zone', 'date'])

// Pinned in each session so the text form of a row is identical on both servers.
export const SESSION_SETTINGS = [
  `set timezone = 'UTC'`,
  `set datestyle = 'ISO'`,
  `set extra_float_digits = 3`,
  `set bytea_output = 'hex'`,
]

function maxTimestampSql(table, column, dataType) {
  const value =
    dataType === 'timestamp with time zone'
      ? `max(${quoteIdent(column)}) at time zone 'UTC'`
      : `max(${quoteIdent(column)})`
  return `select to_char(${value}, 'YYYY-MM-DD"T"HH24:MI:SS.US') as v from public.${quoteIdent(table)}`
}

async function primaryKeyColumns(client, table) {
  const result = await client.query(
    `select a.attname
       from pg_index i
       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
      where i.indrelid = $1::regclass and i.indisprimary
      order by array_position(i.indkey::int2[], a.attnum)`,
    [`public.${quoteIdent(table)}`],
  )
  return result.rows.map((row) => row.attname)
}

/** md5 over every row's text form, ordered by primary key (or by the row hash). */
export async function rowHash(client, table, pkColumns) {
  const key = pkColumns.length
    ? `concat_ws(chr(31), ${pkColumns.map((column) => `tbl_row.${quoteIdent(column)}::text`).join(', ')})`
    : `md5(tbl_row::text)`
  const result = await client.query(
    `select coalesce(md5(string_agg(h, '' order by k collate "C")), 'empty') as h
       from (select md5(tbl_row::text) as h, ${key} as k from public.${quoteIdent(table)} tbl_row) s`,
  )
  return result.rows[0].h
}

/** sha256 over the ordered primary keys of one table, or null when it has none. */
export async function primaryKeyHash(client, table, knownColumns) {
  const columns = knownColumns || (await primaryKeyColumns(client, table))
  if (columns.length === 0) return null
  const keyExpression = `concat_ws(chr(31), ${columns.map((column) => `${quoteIdent(column)}::text`).join(', ')})`
  const result = await client.query(
    `select encode(sha256(convert_to(coalesce(string_agg(k, chr(10) order by k collate "C"), ''), 'UTF8')), 'hex') as h
       from (select ${keyExpression} as k from public.${quoteIdent(table)}) s`,
  )
  return result.rows[0].h
}

/** Everything about one side: tables, counts, newest timestamps, full-row hashes, sizes. */
export async function collectSide(client) {
  for (const statement of SESSION_SETTINGS) await client.query(statement)

  const tablesResult = await client.query(
    `select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`,
  )
  const columnsResult = await client.query(
    `select table_name, column_name, data_type from information_schema.columns
      where table_schema = 'public' order by table_name, ordinal_position`,
  )
  const columnNames = new Map()
  const timestampColumns = new Map()
  for (const row of columnsResult.rows) {
    const names = columnNames.get(row.table_name) || []
    names.push(row.column_name)
    columnNames.set(row.table_name, names)
    if (!['updated_at', 'created_at'].includes(row.column_name)) continue
    if (!TIMESTAMP_TYPES.has(row.data_type)) continue
    const list = timestampColumns.get(row.table_name) || []
    list.push({ column: row.column_name, dataType: row.data_type })
    timestampColumns.set(row.table_name, list)
  }

  const tables = new Map()
  for (const { table_name: name } of tablesResult.rows) {
    const count = await client.query(`select count(*)::text as n from public.${quoteIdent(name)}`)
    const pk = await primaryKeyColumns(client, name)
    const entry = {
      count: Number(count.rows[0].n),
      max: {},
      bytes: 0,
      columns: columnNames.get(name) || [],
      pk,
      rowHash: await rowHash(client, name, pk),
    }
    for (const { column, dataType } of timestampColumns.get(name) || []) {
      const result = await client.query(maxTimestampSql(name, column, dataType))
      entry.max[column] = result.rows[0].v ?? null
    }
    const size = await client.query(`select pg_total_relation_size($1::regclass)::text as b`, [
      `public.${quoteIdent(name)}`,
    ])
    entry.bytes = Number(size.rows[0].b)
    tables.set(name, entry)
  }
  const database = await client.query(`select pg_database_size(current_database())::text as b`)
  return { tables, databaseBytes: Number(database.rows[0].b) }
}

/** The tables present on both sides, largest first, capped at the hash limit. */
export function largestTables(source, target, limit = HASH_TABLE_LIMIT) {
  const both = [...source.tables.keys()].filter((name) => target.tables.has(name))
  const size = (name) => Math.max(source.tables.get(name).count, target.tables.get(name).count)
  return both.sort((a, b) => size(b) - size(a) || a.localeCompare(b)).slice(0, limit)
}

/**
 * Pure comparison. `hashes` is { table: { source, target } } primary-key hashes
 * for the largest tables. Returns one row per table plus the mismatch count.
 */
export function compareSides(source, target, { allowMissing = [], hashes = {} } = {}) {
  const allowed = new Set(allowMissing)
  const names = [...new Set([...source.tables.keys(), ...target.tables.keys()])].sort()
  const rows = []
  const notes = []
  let mismatches = 0

  for (const table of names) {
    const s = source.tables.get(table)
    const t = target.tables.get(table)
    const row = { table, source: s?.count ?? null, target: t?.count ?? null, status: 'ok', detail: '', hash: '-', rows: '-' }

    if (!s || !t) {
      const present = s || t
      const side = s ? 'target' : 'source'
      if (!allowed.has(table)) {
        row.status = 'MISMATCH'
        row.detail = `missing on ${side}`
      } else if (present.count > 0) {
        row.status = 'MISMATCH'
        row.detail = `allowed to be missing on ${side}, but the other side holds ${present.count} rows`
      } else {
        row.status = 'allowed'
        row.detail = `absent on ${side}${side === 'source' ? ' (the dump predates it; boot DDL creates it)' : ''}`
        notes.push(`${table}: absent on ${side}, empty on the other side`)
      }
    } else {
      const problems = []
      if (s.count !== t.count) problems.push(`rows ${s.count} vs ${t.count}`)
      for (const column of ['updated_at', 'created_at']) {
        if (column in s.max || column in t.max) {
          if ((s.max[column] ?? null) !== (t.max[column] ?? null)) {
            problems.push(`max(${column}) ${s.max[column] ?? 'null'} vs ${t.max[column] ?? 'null'}`)
          }
        }
      }
      const lacking = (s.columns || []).filter((column) => !(t.columns || []).includes(column))
      const extra = (t.columns || []).filter((column) => !(s.columns || []).includes(column))
      if (lacking.length) {
        problems.push(`columns missing on target: ${lacking.join(', ')}`)
      } else if (extra.length) {
        row.rows = 'skipped'
        notes.push(`${table}: target has extra column(s) ${extra.join(', ')} (boot DDL); full-row hash skipped`)
      } else if (s.rowHash !== undefined || t.rowHash !== undefined) {
        if (s.rowHash === t.rowHash) {
          row.rows = 'match'
        } else {
          row.rows = 'DIFF'
          problems.push('full-row hash differs')
        }
      }
      const hash = hashes[table]
      if (hash) {
        if (hash.source === null && hash.target === null) {
          row.hash = 'no pk'
        } else if (hash.source === hash.target) {
          row.hash = 'match'
        } else {
          row.hash = 'DIFF'
          problems.push('primary-key hash differs')
        }
      }
      if (problems.length) {
        row.status = 'MISMATCH'
        row.detail = problems.join('; ')
      }
    }
    if (row.status === 'MISMATCH') mismatches += 1
    rows.push(row)
  }
  return { rows, mismatches, notes }
}

export function formatReport(result, source, target) {
  const header = ['table', 'source', 'target', 'row-md5', 'pk-sha256', 'status']
  const lines = result.rows.map((row) => [
    row.table,
    row.source === null ? '-' : String(row.source),
    row.target === null ? '-' : String(row.target),
    row.rows,
    row.hash,
    row.detail ? `${row.status}: ${row.detail}` : row.status,
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((line) => line[i].length)))
  const fmt = (cells) => cells.map((cell, i) => (i === 1 || i === 2 ? cell.padStart(widths[i]) : cell.padEnd(widths[i]))).join('  ')
  const out = [fmt(header), widths.map((w) => '-'.repeat(w)).join('  '), ...lines.map(fmt)]
  out.push('')
  out.push(`database size  source ${formatBytes(source.databaseBytes)}   target ${formatBytes(target.databaseBytes)}  (estimates; a restored copy is normally smaller)`)
  const bySize = [...target.tables.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 5)
  out.push(`largest on target: ${bySize.map(([name, entry]) => `${name} ${formatBytes(entry.bytes)}`).join(', ')}`)
  return out
}

export async function main(argv, env = process.env, deps = {}) {
  const log = deps.log || console.log
  const connect = deps.connect || connectClient

  let parsed
  let source
  let target
  try {
    parsed = parseArgs(argv, { options: ['allow-missing'] })
    source = readUrl(env, null, 'SOURCE_DATABASE_URL')
    target = readUrl(env, null, 'TARGET_DATABASE_URL')
  } catch (error) {
    log(`verify: ${error.message}`)
    return 2
  }
  if (sameDatabase(source.url, target.url)) {
    log('verify: REFUSED - source and target are the same database; the comparison would prove nothing')
    return 2
  }
  if (isPoolerHost(source.url) || isPoolerHost(target.url)) {
    log('verify: REFUSED - a Neon pooled (-pooler) endpoint cannot hold the session settings the hash needs. Use the DIRECT connection string.')
    return 2
  }
  const allowMissing = (parsed.options['allow-missing'] || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)

  log(`verify: source ${describeTarget(source.url)}  target ${describeTarget(target.url)}`)
  const sourceClient = await connect(source.url)
  const targetClient = await connect(target.url)
  try {
    const sourceSide = await collectSide(sourceClient)
    const targetSide = await collectSide(targetClient)
    const hashes = {}
    for (const table of largestTables(sourceSide, targetSide)) {
      hashes[table] = {
        source: await primaryKeyHash(sourceClient, table, sourceSide.tables.get(table).pk),
        target: await primaryKeyHash(targetClient, table, targetSide.tables.get(table).pk),
      }
    }
    const result = compareSides(sourceSide, targetSide, { allowMissing, hashes })
    for (const line of formatReport(result, sourceSide, targetSide)) log(line)
    for (const note of result.notes) log(`note: ${note}`)
    if (result.mismatches > 0) {
      log(`verify: FAILED - ${result.mismatches} table(s) differ`)
      return 1
    }
    log(`verify: OK - ${result.rows.length} tables match (every table by full-row hash; ${Object.keys(hashes).length} also by primary-key hash)`)
    return 0
  } finally {
    await sourceClient.end()
    await targetClient.end()
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`verify: ${error.message}`)
      process.exit(1)
    },
  )
}
