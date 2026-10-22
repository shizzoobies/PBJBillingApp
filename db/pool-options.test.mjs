import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

// A recording fake for node-pg: every Pool the store builds lands in `created`.
vi.mock('pg', () => {
  const created = []
  class Pool {
    constructor(options) {
      created.push(options)
    }
  }
  return { default: { Pool, Client: class {} }, __created: created }
})

import { poolOptions } from './pool-options.js'

const NEON =
  'postgresql://app_owner:p%40ss%2Fword@ep-quiet-sky-123456.us-east-1.aws.neon.tech/neondb?sslmode=verify-full'
const RAILWAY_INTERNAL = 'postgresql://postgres:secret@postgres.railway.internal:5432/railway'

describe('poolOptions', () => {
  it('leaves Railway\'s internal non-TLS URL exactly as it was', () => {
    expect(poolOptions(RAILWAY_INTERNAL, {})).toEqual({ connectionString: RAILWAY_INTERNAL })
  })

  it('verifies the certificate for sslmode=verify-full in the URL and strips the parameter', () => {
    const options = poolOptions(NEON, {})
    expect(options.ssl).toEqual({ rejectUnauthorized: true })
    expect(options.connectionString).toBe(
      'postgresql://app_owner:p%40ss%2Fword@ep-quiet-sky-123456.us-east-1.aws.neon.tech/neondb',
    )
  })

  it('keeps other query parameters when it removes sslmode, wherever it sits', () => {
    const base = 'postgresql://u:p@h.example/db'
    for (const url of [
      `${base}?sslmode=require&application_name=pbj`,
      `${base}?application_name=pbj&sslmode=require`,
      `${base}?application_name=pbj&sslmode=require&connect_timeout=5`,
    ]) {
      const options = poolOptions(url, {})
      expect(options.connectionString).not.toMatch(/sslmode/)
      expect(options.ssl).toEqual({ rejectUnauthorized: true })
    }
    expect(poolOptions(`${base}?application_name=pbj&sslmode=require`, {}).connectionString).toBe(
      `${base}?application_name=pbj`,
    )
  })

  it('treats sslmode=require as a VERIFIED connection, never an unchecked one', () => {
    expect(poolOptions('postgresql://u:p@h/db?sslmode=require', {}).ssl).toEqual({ rejectUnauthorized: true })
    expect(poolOptions('postgresql://u:p@h/db?sslmode=verify-ca', {}).ssl).toEqual({ rejectUnauthorized: true })
  })

  it('honors PGSSLMODE when the URL says nothing, and lets the URL win when it does', () => {
    expect(poolOptions(RAILWAY_INTERNAL, { PGSSLMODE: 'verify-full' }).ssl).toEqual({ rejectUnauthorized: true })
    expect(poolOptions(`${RAILWAY_INTERNAL}?sslmode=disable`, { PGSSLMODE: 'verify-full' }).ssl).toBe(false)
  })

  it('maps disable/allow/prefer to plain connections', () => {
    for (const mode of ['disable', 'allow', 'prefer']) {
      expect(poolOptions(RAILWAY_INTERNAL, { PGSSLMODE: mode }).ssl).toBe(false)
    }
  })

  it('refuses to turn certificate checking off, or to guess at an unknown mode', () => {
    expect(() => poolOptions(RAILWAY_INTERNAL, { PGSSLMODE: 'no-verify' })).toThrow(/Unsupported sslmode/)
    expect(() => poolOptions(`${RAILWAY_INTERNAL}?sslmode=bogus`, {})).toThrow(/Unsupported sslmode/)
  })

  it('drops sslrootcert=system (Node already uses its bundled roots) and keeps the rest', () => {
    const base = 'postgresql://u:p@h.example/db'
    const options = poolOptions(`${base}?sslmode=verify-full&sslrootcert=system`, {})
    expect(options).toEqual({ connectionString: base, ssl: { rejectUnauthorized: true } })
    expect(poolOptions(`${base}?sslrootcert=system&application_name=pbj&sslmode=require`, {}).connectionString).toBe(
      `${base}?application_name=pbj`,
    )
  })

  it('never writes an unchecked-certificate setting anywhere in the app\'s database code', () => {
    for (const file of ['./pool-options.js', './store.js']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      expect(source).not.toMatch(/rejectUnauthorized\s*:\s*false/)
    }
  })
})

describe('AppDataStore pool construction', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  async function poolsBuiltFor(env) {
    vi.stubEnv('DATABASE_URL', env.DATABASE_URL)
    vi.stubEnv('PGSSLMODE', env.PGSSLMODE ?? '')
    const pgModule = await import('pg')
    const before = pgModule.__created.length
    const { AppDataStore } = await import('./store.js')
    new AppDataStore()
    return pgModule.__created.slice(before)
  }

  it('Neon: verify-full URL gives a verified TLS pool', async () => {
    const [options] = await poolsBuiltFor({ DATABASE_URL: NEON })
    expect(options.ssl).toEqual({ rejectUnauthorized: true })
    expect(options.connectionString).not.toMatch(/sslmode/)
  })

  it('Railway internal URL: no ssl option at all', async () => {
    const [options] = await poolsBuiltFor({ DATABASE_URL: RAILWAY_INTERNAL })
    expect(options).toEqual({ connectionString: RAILWAY_INTERNAL })
    expect('ssl' in options).toBe(false)
  })

  it('PGSSLMODE=verify-full on a plain URL gives a verified TLS pool', async () => {
    const [options] = await poolsBuiltFor({ DATABASE_URL: RAILWAY_INTERNAL, PGSSLMODE: 'verify-full' })
    expect(options.ssl).toEqual({ rejectUnauthorized: true })
  })

  it('no DATABASE_URL: no pool (file backend)', async () => {
    vi.stubEnv('DATABASE_URL', '')
    const pgModule = await import('pg')
    const before = pgModule.__created.length
    const { AppDataStore } = await import('./store.js')
    const store = new AppDataStore()
    expect(store.pool).toBeNull()
    expect(pgModule.__created.length).toBe(before)
  })
})
