import { EventEmitter } from 'node:events'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { REPO_ROOT, cleanupToolEnv, isCloudSyncedPath, isPoolerHost, libpqEnv, parseArgs, pgBinary, redact, toolEnv, utcStamp } from '../scripts/migrate/lib.mjs'
import { dumpArgs, main as dumpMain } from '../scripts/migrate/dump.mjs'
import { IGNORED_SCHEMAS, main as restoreMain, restoreArgs } from '../scripts/migrate/restore.mjs'
import { compareSides, largestTables, main as verifyMain } from '../scripts/migrate/verify.mjs'
import { diffStats, main as bootCheckMain } from '../scripts/migrate/boot-check.mjs'

const PASSWORD = 'hunter2/with@odd&chars'
const SOURCE_URL = `postgresql://postgres:${encodeURIComponent(PASSWORD)}@localhost:54321/railway`
const TARGET_URL = `postgresql://app_owner:${encodeURIComponent(PASSWORD)}@ep-quiet-sky-123.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require`
const NOW = new Date('2026-10-22T03:04:05Z')

/** A recording fake for child_process.spawn. `plan(file, args)` scripts each call. */
function fakeSpawn(plan = () => ({ code: 0 })) {
  const calls = []
  const spawn = (file, args, options) => {
    calls.push({ file, args, env: options.env })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    const result = plan(file, args)
    setImmediate(() => {
      if (result.stdout) child.stdout.emit('data', result.stdout)
      if (result.stderr) child.stderr.emit('data', result.stderr)
      child.emit('close', result.code)
    })
    return child
  }
  return { spawn, calls }
}

function collector() {
  const lines = []
  return { log: (line) => lines.push(String(line)), lines, text: () => lines.join('\n') }
}

describe('lib', () => {
  it('parses --name value, --name=value and flags, and rejects the unknown', () => {
    const spec = { options: ['out', 'file'], flags: ['force'] }
    expect(parseArgs(['--out', 'x', '--file=y', '--force'], spec)).toEqual({
      options: { out: 'x', file: 'y' },
      flags: { force: true },
      rest: [],
    })
    expect(() => parseArgs(['--nope'], spec)).toThrow(/Unknown option --nope/)
    expect(() => parseArgs(['--out'], spec)).toThrow(/needs a value/)
    expect(() => parseArgs(['--out', '--force'], spec)).toThrow(/needs a value/)
  })

  it('finds the PostgreSQL binaries: PG_BIN, the Windows default, or PATH', () => {
    expect(pgBinary('pg_dump', {}, 'win32')).toBe('C:\\Program Files\\PostgreSQL\\18\\bin\\pg_dump.exe')
    expect(pgBinary('pg_dump', { PG_BIN: 'D:\\pg\\bin' }, 'win32')).toBe('D:\\pg\\bin\\pg_dump.exe')
    expect(pgBinary('pg_restore', {}, 'linux')).toBe('pg_restore')
    expect(pgBinary('psql', { PG_BIN: '/opt/pg18/bin' }, 'linux')).toBe(path.join('/opt/pg18/bin', 'psql'))
  })

  it('splits a URL into libpq variables, decoding the password', () => {
    expect(libpqEnv(TARGET_URL)).toEqual({
      PGHOST: 'ep-quiet-sky-123.us-east-1.aws.neon.tech',
      PGUSER: 'app_owner',
      PGPASSWORD: PASSWORD,
      PGDATABASE: 'neondb',
      PGSSLMODE: 'require',
      PGCHANNELBINDING: 'require',
    })
    expect(libpqEnv(SOURCE_URL)).toMatchObject({ PGHOST: 'localhost', PGPORT: '54321', PGDATABASE: 'railway' })
  })

  it('an invalid URL error never contains the URL', () => {
    expect(() => libpqEnv('not a url but secret-123')).toThrow(/not a valid/)
    try {
      libpqEnv('not a url but secret-123')
    } catch (error) {
      expect(error.message).not.toContain('secret-123')
    }
  })

  it('hands a tool only its own connection: stray PG* and *_DATABASE_URL variables are dropped', () => {
    const env = toolEnv(
      { PATH: '/bin', PGPASSWORD: 'stale', PGHOST: 'stale', SOURCE_DATABASE_URL: SOURCE_URL, DATABASE_URL: 'x' },
      TARGET_URL,
    )
    expect(env.PATH).toBe('/bin')
    expect(env.PGPASSWORD).toBe(PASSWORD)
    expect(env.PGHOST).toMatch(/neon\.tech$/)
    expect(env.SOURCE_DATABASE_URL).toBeUndefined()
    expect(env.DATABASE_URL).toBeUndefined()
  })

  it('a remote host is verified like the app does: verify-full plus a temporary root-certificate file', () => {
    const noMode = TARGET_URL.replace('?sslmode=require&channel_binding=require', '')
    for (const url of [TARGET_URL, noMode, TARGET_URL.replace('sslmode=require', 'sslmode=verify-full')]) {
      const env = toolEnv({ PATH: '/bin' }, url)
      expect(env.PGSSLMODE).toBe('verify-full')
      expect(existsSync(env.PGSSLROOTCERT)).toBe(true)
      expect(readFileSync(env.PGSSLROOTCERT, 'utf8')).toContain('-----BEGIN CERTIFICATE-----')
      cleanupToolEnv(env)
      expect(existsSync(env.PGSSLROOTCERT)).toBe(false)
    }
    const kept = toolEnv({}, TARGET_URL)
    expect(kept.PGCHANNELBINDING).toBe('require')
    cleanupToolEnv(kept)
  })

  it('refuses a remote URL that would leave the server unverified, without showing the URL', () => {
    for (const mode of ['disable', 'allow', 'prefer', 'no-verify']) {
      const url = TARGET_URL.replace('sslmode=require', 'sslmode=' + mode)
      expect(() => toolEnv({}, url)).toThrow(/unverified/)
      try {
        toolEnv({}, url)
      } catch (error) {
        expect(error.message).not.toContain(PASSWORD)
        expect(error.message).not.toContain('postgresql://')
      }
    }
  })

  it('a local host (the Railway tunnel) is left alone: no mode forced, no certificate file', () => {
    expect(toolEnv({}, SOURCE_URL).PGSSLMODE).toBeUndefined()
    expect(toolEnv({}, SOURCE_URL).PGSSLROOTCERT).toBeUndefined()
    const plain = toolEnv({}, 'postgresql://u:p@127.0.0.1:5432/db?sslmode=disable')
    expect(plain.PGSSLMODE).toBe('disable')
    expect(plain.PGSSLROOTCERT).toBeUndefined()
    cleanupToolEnv(plain)
  })

  it('redacts URLs and passwords out of tool output', () => {
    const text = `connection to ${SOURCE_URL} failed; password ${PASSWORD} rejected; also postgres://a:b@c/d`
    const out = redact(text, [SOURCE_URL])
    expect(out).not.toContain(PASSWORD)
    expect(out).not.toContain(encodeURIComponent(PASSWORD))
    expect(out).not.toContain('postgres://a:b')
  })

  it('stamps UTC time as YYYYMMDD-HHMMSS', () => {
    expect(utcStamp(NOW)).toBe('20261022-030405')
  })
})

describe('dump.mjs', () => {
  const outDir = path.resolve('/dumps-outside-the-repo')
  const finalFile = path.join(outDir, 'backups', 'railway-20261022-030405.dump')
  const expectedFile = `${finalFile}.partial`
  const fs = { mkdir: vi.fn(async () => {}), stat: vi.fn(async () => ({ size: 175 * 1024 * 1024 })), rm: vi.fn(async () => {}), rename: vi.fn(async () => {}) }

  it('runs the exact pg_dump command, with the URL in the environment and not in argv', async () => {
    const { spawn, calls } = fakeSpawn((file) => (file.includes('pg_restore') ? { code: 0, stdout: '; header\n1; 1 2 TABLE x\n2; 1 3 TABLE y\n' } : { code: 0 }))
    const out = collector()
    const code = await dumpMain(['--out', outDir], { SOURCE_DATABASE_URL: SOURCE_URL, PG_BIN: '/pg18' }, { ...out, spawn, now: () => NOW, platform: 'linux', ...fs })
    expect(code).toBe(0)
    expect(calls[0].file).toBe(path.join('/pg18', 'pg_dump'))
    expect(calls[0].args).toEqual(['-Fc', '--no-owner', '--no-privileges', '--no-comments', '-f', expectedFile])
    expect(calls[0].args).toEqual(dumpArgs(expectedFile))
    expect(calls[0].env).toMatchObject({ PGHOST: 'localhost', PGPORT: '54321', PGUSER: 'postgres', PGPASSWORD: PASSWORD, PGDATABASE: 'railway' })
    expect(calls[1].args).toEqual(['--list', expectedFile])
    for (const call of calls) {
      expect(call.args.join(' ')).not.toContain(PASSWORD)
      expect(call.args.join(' ')).not.toContain('postgres://')
    }
    expect(fs.rename).toHaveBeenCalledWith(expectedFile, finalFile)
    expect(out.text()).toContain(`OK ${finalFile}`)
    expect(out.text()).toContain('pg_dump exit code 0')
    expect(out.text()).toContain('175.0 MB')
    expect(out.text()).not.toContain(PASSWORD)
  })

  it('reads the URL from the variable --source-url-env names', async () => {
    const { spawn, calls } = fakeSpawn()
    await dumpMain(['--out', outDir, '--source-url-env', 'MY_URL'], { MY_URL: SOURCE_URL }, { ...collector(), spawn, now: () => NOW, platform: 'linux', ...fs })
    expect(calls[0].env.PGDATABASE).toBe('railway')
  })

  it('a non-zero pg_dump exit is a failure: partial file removed, stderr redacted, exit 1', async () => {
    const rm = vi.fn(async () => {})
    const { spawn } = fakeSpawn(() => ({ code: 1, stderr: `pg_dump: error: connection to server at ${SOURCE_URL} failed\n` }))
    const out = collector()
    const code = await dumpMain(['--out', outDir], { SOURCE_DATABASE_URL: SOURCE_URL }, { ...out, spawn, now: () => NOW, ...fs, rm })
    expect(code).toBe(1)
    expect(rm).toHaveBeenCalledWith(expectedFile, { force: true })
    expect(out.text()).toContain('exit code 1')
    expect(out.text()).not.toContain(PASSWORD)
  })

  it('names the missing variable, not a value, and does not spawn anything', async () => {
    const { spawn, calls } = fakeSpawn()
    const out = collector()
    const code = await dumpMain([], {}, { ...out, spawn, ...fs })
    expect(code).toBe(2)
    expect(out.text()).toContain('SOURCE_DATABASE_URL is not set')
    expect(calls).toHaveLength(0)
  })

  it('refuses an output folder inside the git repository', async () => {
    const { spawn, calls } = fakeSpawn()
    const out = collector()
    const code = await dumpMain(['--out', path.join(REPO_ROOT, 'backups-here')], { SOURCE_DATABASE_URL: SOURCE_URL }, { ...out, spawn, ...fs })
    expect(code).toBe(2)
    expect(out.text()).toContain('inside the git repository')
    expect(calls).toHaveLength(0)
  })

  it('rejects an unreadable archive (pg_restore --list fails) even when pg_dump exited 0', async () => {
    const { spawn } = fakeSpawn((file) => (file.includes('pg_restore') ? { code: 1, stderr: 'pg_restore: error: unsupported version' } : { code: 0 }))
    const rename = vi.fn(async () => {})
    const rm = vi.fn(async () => {})
    const code = await dumpMain(['--out', outDir], { SOURCE_DATABASE_URL: SOURCE_URL }, { ...collector(), spawn, now: () => NOW, ...fs, rename, rm })
    expect(code).toBe(1)
    expect(rename).not.toHaveBeenCalled()
    expect(rm).toHaveBeenCalledWith(expectedFile, { force: true })
  })

  it('never gives a failed dump its real name', async () => {
    const rename = vi.fn(async () => {})
    const { spawn } = fakeSpawn(() => ({ code: 1, stderr: 'boom' }))
    await dumpMain(['--out', outDir], { SOURCE_DATABASE_URL: SOURCE_URL }, { ...collector(), spawn, now: () => NOW, ...fs, rename })
    expect(rename).not.toHaveBeenCalled()
  })

  it('refuses a cloud-synced output folder', async () => {
    const { spawn, calls } = fakeSpawn()
    const out = collector()
    const code = await dumpMain(['--out', path.resolve('/Users/me/OneDrive/dumps')], { SOURCE_DATABASE_URL: SOURCE_URL }, { ...out, spawn, ...fs })
    expect(code).toBe(2)
    expect(out.text()).toContain('cloud-synced')
    expect(calls).toHaveLength(0)
    expect(isCloudSyncedPath('C:/Users/me/Dropbox/x')).toBe(true)
    expect(isCloudSyncedPath('D:/PBJ Accounting Work/secrets/dumps')).toBe(false)
  })
})

describe('restore.mjs', () => {
  const file = path.resolve('some.dump')
  const access = async () => {}

  function fakeConnect(tables) {
    const queries = []
    const client = {
      query: vi.fn(async (sql, params) => {
        queries.push({ sql, params })
        return sql.includes('pg_class')
          ? { rows: tables.map(([relation_schema, relation_name]) => ({ relation_schema, relation_name })) }
          : { rows: [] }
      }),
      end: vi.fn(async () => {}),
    }
    return { connect: vi.fn(async () => client), queries, client }
  }

  it('refuses a target that already has user relations, and runs nothing', async () => {
    const { spawn, calls } = fakeSpawn()
    const { connect } = fakeConnect([['public', 'clients'], ['public', 'users']])
    const out = collector()
    const code = await restoreMain(['--file', file], { TARGET_DATABASE_URL: TARGET_URL }, { ...out, spawn, connect, access })
    expect(code).toBe(2)
    expect(out.text()).toContain('REFUSED')
    expect(out.text()).toContain('public.clients')
    expect(calls).toHaveLength(0)
  })

  it('asks about tables, partitions, sequences, views and matviews outside the system and Neon schemas', async () => {
    const { spawn } = fakeSpawn()
    const { connect, queries } = fakeConnect([])
    await restoreMain(['--file', file], { TARGET_DATABASE_URL: TARGET_URL }, { ...collector(), spawn, connect, access })
    expect(queries[0].params).toEqual([IGNORED_SCHEMAS])
    expect(queries[0].sql).toContain("relkind in ('r', 'p', 'S', 'v', 'm')")
    expect(IGNORED_SCHEMAS).toEqual(expect.arrayContaining(['pg_catalog', 'information_schema', 'pg_toast']))
  })

  it('on an empty target runs the exact pg_restore command with the URL only in the environment', async () => {
    const { spawn, calls } = fakeSpawn(() => ({ code: 0 }))
    const { connect, queries } = fakeConnect([])
    const out = collector()
    const code = await restoreMain(['--file', file], { TARGET_DATABASE_URL: TARGET_URL, PG_BIN: '/pg18' }, { ...out, spawn, connect, access, platform: 'linux' })
    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe(path.join('/pg18', 'pg_restore'))
    expect(calls[0].args).toEqual(['--no-owner', '--no-privileges', '--exit-on-error', '--jobs', '2', '-d', 'neondb', file])
    expect(calls[0].args).toEqual(restoreArgs('neondb', file))
    expect(calls[0].args.join(' ')).not.toContain(PASSWORD)
    expect(calls[0].args.join(' ')).not.toContain('neon.tech')
    expect(calls[0].env).toMatchObject({ PGHOST: expect.stringContaining('neon.tech'), PGPASSWORD: PASSWORD, PGDATABASE: 'neondb' })
    expect(queries.some((q) => q.sql === 'analyze')).toBe(true)
    expect(out.text()).toContain('pg_restore exit code 0')
    expect(out.text()).toContain('verify.mjs (no allowances), then boot-check.mjs, then verify.mjs --allow-missing')
    // The temporary root-certificate file is gone once the tool has exited.
    expect(calls[0].env.PGSSLMODE).toBe('verify-full')
    expect(existsSync(calls[0].env.PGSSLROOTCERT)).toBe(false)
  })

  it('--force skips the emptiness question but still runs pg_restore', async () => {
    const { spawn, calls } = fakeSpawn()
    const { connect, queries } = fakeConnect([['public', 'clients']])
    const code = await restoreMain(['--file', file, '--force'], { TARGET_DATABASE_URL: TARGET_URL }, { ...collector(), spawn, connect, access })
    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(queries.every((q) => !q.sql.includes('pg_class'))).toBe(true)
  })

  it('prints the exit code and only the last 20 stderr lines, redacted; failure exits 1', async () => {
    const stderr = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') + `\nconnection ${TARGET_URL}\n`
    const { spawn } = fakeSpawn(() => ({ code: 1, stderr }))
    const { connect } = fakeConnect([])
    const out = collector()
    const code = await restoreMain(['--file', file], { TARGET_DATABASE_URL: TARGET_URL }, { ...out, spawn, connect, access })
    expect(code).toBe(1)
    expect(out.text()).toContain('pg_restore exit code 1')
    expect(out.text()).toContain('line 30')
    expect(out.text()).toContain('line 12')
    expect(out.text()).not.toMatch(/line 11/)
    expect(out.text()).not.toMatch(/line 1\b/)
    expect(out.text()).not.toContain(PASSWORD)
    expect(out.text()).not.toContain('neon.tech/neondb?')
  })

  it('refuses when the target is the same database as SOURCE_DATABASE_URL', async () => {
    const { spawn, calls } = fakeSpawn()
    const { connect } = fakeConnect([])
    const code = await restoreMain(['--file', file, '--force'], { TARGET_DATABASE_URL: SOURCE_URL, SOURCE_DATABASE_URL: SOURCE_URL }, { ...collector(), spawn, connect, access })
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })

  it('refuses a Neon pooled (-pooler) endpoint without connecting', async () => {
    const { spawn, calls } = fakeSpawn()
    const { connect } = fakeConnect([])
    const pooled = 'postgresql://u:p@ep-quiet-sky-123-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require'
    const out = collector()
    expect(await restoreMain(['--file', file], { TARGET_DATABASE_URL: pooled }, { ...out, spawn, connect, access })).toBe(2)
    expect(out.text()).toContain('pooler')
    expect(connect).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('needs --file and an existing file', async () => {
    const { spawn } = fakeSpawn()
    expect(await restoreMain([], { TARGET_DATABASE_URL: TARGET_URL }, { ...collector(), spawn })).toBe(2)
    const missing = async () => {
      throw new Error('ENOENT')
    }
    expect(await restoreMain(['--file', 'nope.dump'], { TARGET_DATABASE_URL: TARGET_URL }, { ...collector(), spawn, access: missing })).toBe(2)
  })
})

describe('verify.mjs', () => {
  const side = (tables, databaseBytes = 1000) => ({
    tables: new Map(
      Object.entries(tables).map(([name, t]) => [
        name,
        { count: t.count, max: t.max || {}, bytes: t.bytes || 10, columns: t.columns || ['id'], pk: t.pk || ['id'], rowHash: t.rowHash ?? 'r' },
      ]),
    ),
    databaseBytes,
  })

  it('passes identical sides', () => {
    const a = side({ clients: { count: 5, max: { updated_at: '2026-10-01T00:00:00.000000' } }, users: { count: 3 } })
    const b = side({ clients: { count: 5, max: { updated_at: '2026-10-01T00:00:00.000000' } }, users: { count: 3 } })
    const result = compareSides(a, b, { hashes: { clients: { source: 'h', target: 'h' } } })
    expect(result.mismatches).toBe(0)
    expect(result.rows.find((r) => r.table === 'clients').hash).toBe('match')
    expect(result.rows.find((r) => r.table === 'users').rows).toBe('match')
  })

  it('flags a row-count difference, a newer timestamp, a hash difference and a missing table', () => {
    const a = side({ clients: { count: 5 }, users: { count: 3, max: { created_at: 'x' } }, t3: { count: 1 }, only_source: { count: 2 } })
    const b = side({ clients: { count: 4 }, users: { count: 3, max: { created_at: 'y' } }, t3: { count: 1 } })
    const result = compareSides(a, b, { hashes: { t3: { source: 'a', target: 'b' } } })
    expect(result.mismatches).toBe(4)
    const by = Object.fromEntries(result.rows.map((r) => [r.table, r]))
    expect(by.clients.detail).toContain('rows 5 vs 4')
    expect(by.users.detail).toContain('max(created_at)')
    expect(by.t3.hash).toBe('DIFF')
    expect(by.only_source.detail).toContain('missing on target')
  })

  it('a changed value with the same keys, counts and timestamps is caught by the full-row hash', () => {
    const a = side({ invoices: { count: 2, rowHash: 'aaa' } })
    const b = side({ invoices: { count: 2, rowHash: 'bbb' } })
    const result = compareSides(a, b, { hashes: { invoices: { source: 'k', target: 'k' } } })
    expect(result.mismatches).toBe(1)
    expect(result.rows[0].rows).toBe('DIFF')
    expect(result.rows[0].detail).toContain('full-row hash differs')
  })

  it('a table with no primary key is still compared by its full rows', () => {
    const a = side({ log_lines: { count: 2, pk: [], rowHash: 'aaa' } })
    const b = side({ log_lines: { count: 2, pk: [], rowHash: 'bbb' } })
    expect(compareSides(a, b).mismatches).toBe(1)
    expect(compareSides(a, side({ log_lines: { count: 2, pk: [], rowHash: 'aaa' } })).mismatches).toBe(0)
  })

  it('extra target columns (boot DDL) skip the row hash with a note; a missing target column is a mismatch', () => {
    const a = side({ clients: { count: 1, columns: ['id', 'name'], rowHash: 'aaa' } })
    const extra = side({ clients: { count: 1, columns: ['id', 'name', 'newcol'], rowHash: 'bbb' } })
    const skipped = compareSides(a, extra)
    expect(skipped.mismatches).toBe(0)
    expect(skipped.rows[0].rows).toBe('skipped')
    expect(skipped.notes[0]).toContain('newcol')
    const lacking = side({ clients: { count: 1, columns: ['id'], rowHash: 'aaa' } })
    const result = compareSides(a, lacking)
    expect(result.mismatches).toBe(1)
    expect(result.rows[0].detail).toContain('columns missing on target: name')
  })

  it('--allow-missing tolerates a table absent on one side only when it is empty', () => {
    const a = side({ clients: { count: 1 } })
    const b = side({ clients: { count: 1 }, signature_requests: { count: 0 } })
    const ok = compareSides(a, b, { allowMissing: ['signature_requests'] })
    expect(ok.mismatches).toBe(0)
    expect(ok.rows.find((r) => r.table === 'signature_requests').detail).toContain('dump predates it')

    const full = side({ clients: { count: 1 }, signature_requests: { count: 2 } })
    expect(compareSides(a, full, { allowMissing: ['signature_requests'] }).mismatches).toBe(1)
    expect(compareSides(a, b, { allowMissing: [] }).mismatches).toBe(1)
  })

  it('hashes the 12 largest tables present on both sides', () => {
    const tables = {}
    for (let i = 0; i < 20; i += 1) tables[`t${String(i).padStart(2, '0')}`] = { count: i }
    const a = side(tables)
    expect(largestTables(a, a)).toHaveLength(12)
    expect(largestTables(a, a)[0]).toBe('t19')
  })

  /**
   * A fake pg client answering the queries verify.mjs asks. `tables` maps a
   * name to a row count, or to { count, rowHash, pk, columns }. `hash` answers
   * the primary-key sha256 query. Every statement is recorded in `statements`.
   */
  function fakeClient(tables, hash) {
    const statements = []
    const spec = (name) => (typeof tables[name] === 'object' ? tables[name] : { count: tables[name] })
    return {
      statements,
      end: vi.fn(async () => {}),
      query: async (sql) => {
        statements.push(sql)
        if (sql.startsWith('set ')) return { rows: [] }
        if (sql.includes('information_schema.tables')) return { rows: Object.keys(tables).map((table_name) => ({ table_name })) }
        if (sql.includes('information_schema.columns')) {
          return {
            rows: Object.keys(tables).flatMap((table_name) =>
              (spec(table_name).columns || ['id']).map((column_name) => ({ table_name, column_name, data_type: 'text' })),
            ),
          }
        }
        const name = /public\."([^"]+)"/.exec(sql)?.[1]
        if (sql.includes('select count(*)')) return { rows: [{ n: String(spec(name).count) }] }
        if (sql.includes('pg_total_relation_size')) return { rows: [{ b: '100' }] }
        if (sql.includes('pg_database_size')) return { rows: [{ b: '5000' }] }
        if (sql.includes('indisprimary')) return { rows: [{ attname: 'id' }] }
        if (sql.includes('tbl_row')) return { rows: [{ h: spec(name).rowHash ?? 'rowhash' }] }
        if (sql.includes('sha256')) return { rows: [{ h: hash }] }
        throw new Error(`unexpected query ${sql}`)
      },
    }
  }
  const env = { SOURCE_DATABASE_URL: SOURCE_URL, TARGET_DATABASE_URL: TARGET_URL }

  it('exits 0 when the databases match, after pinning the session settings on both sides', async () => {
    const clients = [fakeClient({ clients: 5 }, 'abc'), fakeClient({ clients: 5 }, 'abc')]
    const both = [...clients]
    const out = collector()
    const code = await verifyMain([], env, { ...out, connect: async () => clients.shift() })
    expect(code).toBe(0)
    expect(out.text()).toContain('verify: OK')
    for (const client of both) {
      expect(client.statements.slice(0, 5)).toEqual([
        "set timezone = 'UTC'",
        "set datestyle = 'ISO'",
        'set extra_float_digits = 3',
        "set bytea_output = 'hex'",
        "set intervalstyle = 'postgres'",
      ])
    }
  })

  it('exits 1 on a row-count mismatch and prints the table', async () => {
    const clients = [fakeClient({ clients: 5 }, 'abc'), fakeClient({ clients: 4 }, 'abc')]
    const out = collector()
    const code = await verifyMain([], env, { ...out, connect: async () => clients.shift() })
    expect(code).toBe(1)
    expect(out.text()).toContain('MISMATCH: rows 5 vs 4')
    expect(out.text()).toContain('verify: FAILED')
  })

  it('exits 1 on a primary-key hash difference even when the counts agree', async () => {
    const clients = [fakeClient({ clients: 5 }, 'abc'), fakeClient({ clients: 5 }, 'xyz')]
    const code = await verifyMain([], env, { ...collector(), connect: async () => clients.shift() })
    expect(code).toBe(1)
  })

  it('exits 1 when only a non-key value differs (full-row hash)', async () => {
    const clients = [fakeClient({ clients: { count: 5, rowHash: 'one' } }, 'abc'), fakeClient({ clients: { count: 5, rowHash: 'two' } }, 'abc')]
    const out = collector()
    const code = await verifyMain([], env, { ...out, connect: async () => clients.shift() })
    expect(code).toBe(1)
    expect(out.text()).toContain('full-row hash differs')
  })

  it('tolerates a table named in --allow-missing', async () => {
    const clients = [fakeClient({ clients: 5 }, 'abc'), fakeClient({ clients: 5, signature_requests: 0 }, 'abc')]
    const code = await verifyMain(['--allow-missing', 'signature_requests, signature_events'], env, { ...collector(), connect: async () => clients.shift() })
    expect(code).toBe(0)
  })

  it('refuses to compare a database with itself, and needs both URLs', async () => {
    const connect = vi.fn()
    expect(await verifyMain([], { SOURCE_DATABASE_URL: SOURCE_URL, TARGET_DATABASE_URL: SOURCE_URL }, { ...collector(), connect })).toBe(2)
    expect(await verifyMain([], { SOURCE_DATABASE_URL: SOURCE_URL }, { ...collector(), connect })).toBe(2)
    expect(connect).not.toHaveBeenCalled()
  })

  it('refuses a Neon pooled endpoint', async () => {
    const connect = vi.fn()
    const pooled = 'postgresql://u:p@ep-quiet-sky-123-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require'
    expect(isPoolerHost(pooled)).toBe(true)
    expect(isPoolerHost(TARGET_URL)).toBe(false)
    expect(await verifyMain([], { SOURCE_DATABASE_URL: SOURCE_URL, TARGET_DATABASE_URL: pooled }, { ...collector(), connect })).toBe(2)
    expect(connect).not.toHaveBeenCalled()
  })
})

describe('boot-check.mjs', () => {
  const stat = (ins, upd, del) => ({ ins: String(ins), upd: String(upd), del: String(del) })

  /** Fake pg client: scripted users count and two stat snapshots (before, after). */
  function harness({ users = 7, before, after }) {
    let statCalls = 0
    const client = {
      end: vi.fn(async () => {}),
      query: async (sql) => {
        if (sql.includes('pg_stat_clear_snapshot')) return { rows: [] }
        if (sql.includes('to_regclass')) return { rows: [{ present: true }] }
        if (sql.includes('information_schema.tables')) return { rows: [{ n: '3' }] }
        if (sql.includes('public.users')) return { rows: [{ n: String(users) }] }
        if (sql.includes('pg_stat_user_tables')) {
          statCalls += 1
          const snapshot = statCalls === 1 ? before : after
          return { rows: Object.entries(snapshot).map(([relname, s]) => ({ relname, ...s })) }
        }
        throw new Error(`unexpected query ${sql}`)
      },
    }
    return { connect: async () => client, sleep: async () => {} }
  }
  const env = { TARGET_DATABASE_URL: TARGET_URL }

  it('diffStats separates created tables from changes to existing ones', () => {
    const before = new Map([['a', { ins: 1, upd: 0, del: 0 }], ['b', { ins: 5, upd: 5, del: 5 }]])
    const after = new Map([['a', { ins: 1, upd: 2, del: 0 }], ['b', { ins: 5, upd: 5, del: 5 }], ['c', { ins: 0, upd: 0, del: 0 }]])
    expect(diffStats(before, after)).toEqual({ created: [{ table: 'c', inserted: 0 }], changed: [{ table: 'a', ins: 0, upd: 2, del: 0 }] })
  })

  it('OK: initialize() ran, new tables listed, nothing existing touched; never writes through the check itself', async () => {
    const { connect, sleep } = harness({
      before: { users: stat(7, 0, 0) },
      after: { users: stat(7, 0, 0), signature_requests: stat(0, 0, 0) },
    })
    const initialize = vi.fn(async () => {
      console.warn('[init] a swallowed warning')
    })
    const end = vi.fn(async () => {})
    const out = collector()
    const code = await bootCheckMain([], env, { ...out, connect, sleep, loadStore: async () => ({ initialize, pool: { end } }) })
    expect(code).toBe(0)
    expect(initialize).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalled()
    expect(out.text()).toContain('created by the boot DDL (1): signature_requests')
    expect(out.text()).toContain('1 warning')
    expect(out.text()).toContain('a swallowed warning')
    expect(out.text()).toContain('boot-check: OK')
  })

  it('exit 3 when initialize() modified an existing table', async () => {
    const { connect, sleep } = harness({ before: { users: stat(7, 0, 0) }, after: { users: stat(7, 1, 0) } })
    const out = collector()
    const code = await bootCheckMain([], env, { ...out, connect, sleep, loadStore: async () => ({ initialize: async () => {}, pool: { end: async () => {} } }) })
    expect(code).toBe(3)
    expect(out.text()).toContain('EXISTING DATA CHANGED')
    expect(out.text()).toContain('users: +0 inserted, 1 updated')
  })

  it('exit 1 and the message when the DDL throws; the pool is still closed', async () => {
    const { connect, sleep } = harness({ before: { users: stat(7, 0, 0) }, after: { users: stat(7, 0, 0) } })
    const end = vi.fn(async () => {})
    const out = collector()
    const code = await bootCheckMain([], env, {
      ...out,
      connect,
      sleep,
      loadStore: async () => ({
        initialize: async () => {
          throw new Error(`permission denied for schema public (${TARGET_URL})`)
        },
        pool: { end },
      }),
    })
    expect(code).toBe(1)
    expect(out.text()).toContain('DDL FAILED - permission denied')
    expect(out.text()).not.toContain(PASSWORD)
    expect(end).toHaveBeenCalled()
  })

  it('refuses an empty database (initialize would seed demo data) unless --allow-empty', async () => {
    const loadStore = vi.fn()
    const { connect, sleep } = harness({ users: 0, before: {}, after: {} })
    const out = collector()
    expect(await bootCheckMain([], env, { ...out, connect, sleep, loadStore })).toBe(2)
    expect(out.text()).toContain('seed the demo users')
    expect(loadStore).not.toHaveBeenCalled()

    const allowed = harness({ users: 0, before: {}, after: {} })
    const code = await bootCheckMain(['--allow-empty'], env, {
      ...collector(),
      ...allowed,
      loadStore: async () => ({ initialize: async () => {}, pool: { end: async () => {} } }),
    })
    expect(code).toBe(0)
  })

  it('refuses a Neon pooled (-pooler) endpoint', async () => {
    const loadStore = vi.fn()
    const pooled = 'postgresql://u:p@ep-quiet-sky-123-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require'
    expect(await bootCheckMain([], { TARGET_DATABASE_URL: pooled }, { ...collector(), loadStore })).toBe(2)
    expect(loadStore).not.toHaveBeenCalled()
  })

  it('refuses a Railway host and the source database', async () => {
    const loadStore = vi.fn()
    const railway = 'postgresql://postgres:x@roundhouse.proxy.rlwy.net:12345/railway'
    expect(await bootCheckMain([], { TARGET_DATABASE_URL: railway }, { ...collector(), loadStore })).toBe(2)
    expect(await bootCheckMain([], { TARGET_DATABASE_URL: SOURCE_URL, SOURCE_DATABASE_URL: SOURCE_URL }, { ...collector(), loadStore })).toBe(2)
    expect(loadStore).not.toHaveBeenCalled()
  })

  it('never calls applyOwnerBootstrapPassword: it is a server.js startup step, not part of initialize()', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(path.resolve(process.cwd(), 'db/store.js'), 'utf8')
    const start = source.indexOf('  async initialize() {')
    const end = source.indexOf('  async migrateRateHistoryInFile()')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    expect(source.slice(start, end)).not.toContain('applyOwnerBootstrapPassword')
    const script = readFileSync(path.resolve(process.cwd(), 'scripts/migrate/boot-check.mjs'), 'utf8')
    expect(script).not.toMatch(/\.applyOwnerBootstrapPassword\(/)
  })
})
