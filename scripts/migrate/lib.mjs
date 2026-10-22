// Shared plumbing for the database migration scripts (dump / restore / verify /
// boot-check). ESM, node built-ins plus `pg` only.
//
// Two rules every script here follows:
//   1. A connection URL comes from the ENVIRONMENT, never from argv and never
//      from the Railway CLI. The scripts print the NAME of the variable they
//      read, never its value.
//   2. The URL never appears in a child process's argv (process listings are
//      readable by other users). pg_dump / pg_restore get the connection as
//      libpq environment variables (PGHOST, PGPORT, PGUSER, PGPASSWORD,
//      PGDATABASE, PGSSLMODE, and for remote hosts PGSSLROOTCERT) and, where a
//      database name is mandatory, the bare database name as `-d <name>`.

import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { poolOptions } from '../../db/pool-options.js'

export const DEFAULT_WIN_PG_BIN = 'C:\\Program Files\\PostgreSQL\\18\\bin'
export const DEFAULT_DUMP_DIR = 'D:\\PBJ Accounting Work\\secrets\\dumps'

const here = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(here, '..', '..')

/**
 * Minimal argv parser. `options` take a value (`--out dir` or `--out=dir`),
 * `flags` do not. Anything else throws, so a typo can never be silently ignored.
 */
export function parseArgs(argv, { options = [], flags = [] } = {}) {
  const out = { options: {}, flags: {}, rest: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      out.rest.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
    if (flags.includes(name)) {
      out.flags[name] = true
    } else if (options.includes(name)) {
      let value = eq === -1 ? argv[i + 1] : arg.slice(eq + 1)
      if (eq === -1) i += 1
      if (value === undefined || (eq === -1 && value.startsWith('--'))) {
        throw new Error(`--${name} needs a value`)
      }
      out.options[name] = value
    } else {
      throw new Error(`Unknown option --${name}`)
    }
  }
  return out
}

/** Path to a PostgreSQL client binary. `PG_BIN` overrides; see the brief. */
export function pgBinary(name, env = process.env, platform = process.platform) {
  const win = platform === 'win32'
  const dir = env.PG_BIN || (win ? DEFAULT_WIN_PG_BIN : '')
  const file = win ? `${name}.exe` : name
  if (!dir) return file
  return win ? path.win32.join(dir, file) : path.join(dir, file)
}

function decode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Splits a postgres:// URL into libpq environment variables. */
export function libpqEnv(connectionUrl) {
  let url
  try {
    url = new URL(connectionUrl)
  } catch {
    throw new Error('The database URL is not a valid postgres:// URL (value not shown).')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('The database URL must start with postgres:// or postgresql:// (value not shown).')
  }
  const env = {}
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host) env.PGHOST = host
  if (url.port) env.PGPORT = url.port
  if (url.username) env.PGUSER = decode(url.username)
  if (url.password) env.PGPASSWORD = decode(url.password)
  const database = decode(url.pathname.replace(/^\//, ''))
  if (database) env.PGDATABASE = database
  const sslmode = url.searchParams.get('sslmode')
  if (sslmode) env.PGSSLMODE = sslmode
  const channelBinding = url.searchParams.get('channel_binding')
  if (channelBinding) env.PGCHANNELBINDING = channelBinding
  return env
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

// Root-certificate files this process wrote for client tools, removed by cleanupToolEnv.
const tempRootCerts = new Set()

/**
 * The environment handed to a PostgreSQL client tool: the caller's own (PATH,
 * SystemRoot, ...) minus anything database-shaped, plus this one connection.
 *
 * Verification matches db/pool-options.js: for any host that is not this machine,
 * `sslmode=require` (or no sslmode) becomes `verify-full`, and the tool is pointed at
 * Node's bundled root certificates (written to a private temporary PEM file, because the
 * Windows EDB OpenSSL has no system store and `sslrootcert=system` fails there). A mode
 * that would leave the server unverified (disable, allow, prefer) is refused for such a
 * host. Call cleanupToolEnv(env) when the tool has exited.
 */
export function toolEnv(baseEnv, connectionUrl) {
  const clean = {}
  for (const [key, value] of Object.entries(baseEnv)) {
    if (/^PG/i.test(key) || /DATABASE_URL$/i.test(key)) continue
    clean[key] = value
  }
  if (!connectionUrl) return clean
  const connection = libpqEnv(connectionUrl)
  if (!LOCAL_HOSTS.has(String(connection.PGHOST || 'localhost').toLowerCase())) {
    const mode = String(connection.PGSSLMODE || 'require').toLowerCase()
    if (mode === 'require' || mode === 'verify-full') connection.PGSSLMODE = 'verify-full'
    else if (mode !== 'verify-ca') {
      throw new Error(
        `The database URL's sslmode "${mode}" would leave the server unverified; use sslmode=require (or verify-full) for ${connection.PGHOST} (URL not shown).`,
      )
    }
    const file = path.join(tmpdir(), `pbj-pgroot-${randomBytes(8).toString('hex')}.pem`)
    writeFileSync(file, `${tls.rootCertificates.join('\n')}\n`, { mode: 0o600 })
    tempRootCerts.add(file)
    connection.PGSSLROOTCERT = file
  }
  return { ...clean, ...connection }
}

/** Removes the temporary root-certificate file toolEnv wrote for this environment, if any. */
export function cleanupToolEnv(env) {
  const file = env?.PGSSLROOTCERT
  if (file && tempRootCerts.delete(file)) rmSync(file, { force: true })
}

/** host:port/database, for comparing two URLs and for safe display. */
export function describeTarget(connectionUrl) {
  const env = libpqEnv(connectionUrl)
  return `${env.PGHOST || 'localhost'}:${env.PGPORT || '5432'}/${env.PGDATABASE || ''}`
}

/**
 * Neon's pooled endpoint (`ep-...-pooler.<region>.aws.neon.tech`) runs
 * PgBouncer in transaction mode: session settings do not stick, pg_dump/
 * pg_restore and DDL are unsafe, and counters would be read from a different
 * backend. Restore, boot-check and verify all need a DIRECT connection.
 */
export function isPoolerHost(connectionUrl) {
  return /-pooler(\.|$)/i.test(libpqEnv(connectionUrl).PGHOST || '')
}

/** A folder that a cloud-sync client would copy off this machine. */
export function isCloudSyncedPath(dir) {
  return /onedrive|dropbox|google ?drive|icloud/i.test(dir)
}

export function sameDatabase(urlA, urlB) {
  return describeTarget(urlA).toLowerCase() === describeTarget(urlB).toLowerCase()
}

/** Removes every secret (and anything URL-shaped) from text before printing. */
export function redact(text, secrets = []) {
  let out = String(text)
  const needles = []
  for (const secret of secrets) {
    if (!secret) continue
    needles.push(secret)
    try {
      const env = libpqEnv(secret)
      if (env.PGPASSWORD) needles.push(env.PGPASSWORD)
      const raw = new URL(secret).password
      if (raw) needles.push(raw)
    } catch {
      /* not a URL: redact it as a plain string */
    }
  }
  needles.sort((a, b) => b.length - a.length)
  // A 1-3 character needle would garble ordinary words; real passwords are longer.
  for (const needle of needles) if (needle.length >= 4) out = out.split(needle).join('***')
  return out.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgres://***')
}

export function lastLines(text, count) {
  const lines = String(text).split(/\r?\n/)
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-count)
}

export function utcStamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  )
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = -1
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

export function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`
}

/**
 * Runs a client tool to completion with stdout/stderr captured (never echoed
 * raw: callers redact first). `spawn` is injected so tests record argv + env.
 */
export function runTool(spawn, file, args, env) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    const MAX = 1_000_000
    child.stdout?.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-MAX)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-MAX)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** Opens a pg client with the app's own TLS rules. Injected as `connect` in tests. */
export async function connectClient(connectionUrl) {
  const client = new pg.Client(poolOptions(connectionUrl))
  await client.connect()
  return client
}

/** True when this file is the process entry point (not imported by a test). */
export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(metaUrl)
}

export function readUrl(env, name, fallbackName) {
  const varName = name || fallbackName
  const value = env[varName]
  if (!value) {
    throw new Error(`${varName} is not set. Export the database URL in that variable (the value is never printed).`)
  }
  return { varName, url: value }
}
