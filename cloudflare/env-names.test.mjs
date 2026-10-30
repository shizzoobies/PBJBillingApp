// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CONTAINER_ENV_NAMES } from './env-names.js'
import { SECRET_NAMES, parseJsonc } from '../scripts/cf/secrets-upload.mjs'

// The container only receives CONTAINER_ENV_NAMES (cloudflare/worker.js), and the uploader
// only sends SECRET_NAMES. A name the app reads that is in neither list silently never
// reaches production, which is how EMAIL_FROM-style settings get lost in a host move.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Read by the app but set by the host or the image, never by us.
const HOST_ONLY = new Set([
  'PORT', // the Dockerfile sets 8080
  'APP_COMMIT', // the Dockerfile build arg / .app-commit file
  'RAILWAY_GIT_COMMIT_SHA', // Railway only; harmless fallback
  'WORKERS_CI_COMMIT_SHA', // Cloudflare Workers Builds only; harmless fallback
  'AUTH_DEMO_PASSWORD', // local dev seeding only
  'FEEDBACK_LOCAL_DIRECTORY', // explicit development/test object storage only
  'NODE_PATH',
  'CI',
  'TMPDIR',
])

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (full.endsWith('.js') && !/\.test\./.test(entry)) out.push(full)
  }
  return out
}

function envReads() {
  const files = [path.join(root, 'server.js'), ...sourceFiles(path.join(root, 'lib')), ...sourceFiles(path.join(root, 'db'))]
  const reads = new Map()
  const patterns = [/\benv\??\.([A-Z][A-Z0-9_]*)\b/g, /\benv\??\.?\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g]
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        if (!reads.has(match[1])) reads.set(match[1], path.relative(root, file))
      }
    }
  }
  return reads
}

const readEnvReadNames = () => [...envReads().keys()]

describe('environment names line up end to end', () => {
  it('finds the reads it is meant to police (the scan itself works)', () => {
    const reads = envReads()
    expect(reads.size).toBeGreaterThan(25)
    for (const name of ['DATABASE_URL', 'EMAIL_FROM', 'AUTOPAY_CHARGING', 'ASSISTANT_MODEL', 'MAINTENANCE_MODE', 'TICK_TOKEN']) {
      expect(reads.has(name), name).toBe(true)
    }
  })

  it('every environment variable the app reads reaches the container, or is host-only', () => {
    const missing = [...envReads()]
      .filter(([name]) => !CONTAINER_ENV_NAMES.includes(name) && !HOST_ONLY.has(name))
      .map(([name, file]) => `${name} (${file})`)
    expect(missing).toEqual([])
  })

  it('no source file pulls variables out of the environment by destructuring (the scan could not see them)', () => {
    const files = [path.join(root, 'server.js'), ...sourceFiles(path.join(root, 'lib')), ...sourceFiles(path.join(root, 'db'))]
    const offenders = files
      .filter((file) => /\}\s*=\s*(?:process\.)?env\b(?!\s*[.\[?])/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file))
    expect(offenders).toEqual([])
  })

  it('the wrangler.jsonc vars are exactly the plain settings, and each reaches the container', () => {
    const config = parseJsonc(readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'))
    const vars = Object.keys(config.vars ?? {})
    for (const name of ['NODE_ENV', 'APP_PUBLIC_URL']) expect(vars, name).toContain(name)
    expect(vars.filter((name) => !['NODE_ENV', 'APP_PUBLIC_URL', 'FIRM_TIME_ZONE'].includes(name))).toEqual([])
    expect(vars.filter((name) => !CONTAINER_ENV_NAMES.includes(name))).toEqual([])
  })

  it('JWT_SECRET is not an app setting (sessions are database rows), so nothing carries it', () => {
    expect(readEnvReadNames()).not.toContain('JWT_SECRET')
    expect(CONTAINER_ENV_NAMES).not.toContain('JWT_SECRET')
    expect(SECRET_NAMES).not.toContain('JWT_SECRET')
  })

  it('every container name is either a wrangler.jsonc var or uploaded as a secret', () => {
    const config = parseJsonc(readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'))
    const vars = Object.keys(config.vars ?? {})
    const unreachable = CONTAINER_ENV_NAMES.filter((name) => !SECRET_NAMES.includes(name) && !vars.includes(name))
    expect(unreachable).toEqual([])
    expect(new Set(CONTAINER_ENV_NAMES).size).toBe(CONTAINER_ENV_NAMES.length)
  })
})
