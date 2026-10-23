import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isAuthenticationPath, isMaintenanceMode, isProviderWebhookPath, maintenanceRefusal, resolveAppCommit } from './host-runtime.js'

describe('resolveAppCommit', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'app-commit-'))
  const file = path.join(dir, '.app-commit')
  writeFileSync(file, 'fedcba9876543210\n')
  const missing = path.join(dir, 'nope')

  it('prefers APP_COMMIT, then Railway, then Workers CI, then the file, then unknown', () => {
    const all = {
      APP_COMMIT: 'aaaaaaa1111',
      RAILWAY_GIT_COMMIT_SHA: 'bbbbbbb2222',
      WORKERS_CI_COMMIT_SHA: 'ccccccc3333',
    }
    expect(resolveAppCommit(all, file)).toBe('aaaaaaa')
    expect(resolveAppCommit({ ...all, APP_COMMIT: '' }, file)).toBe('bbbbbbb')
    expect(resolveAppCommit({ WORKERS_CI_COMMIT_SHA: 'ccccccc3333' }, file)).toBe('ccccccc')
    expect(resolveAppCommit({}, file)).toBe('fedcba9')
    expect(resolveAppCommit({}, missing)).toBe('unknown')
  })

  it('treats the Dockerfile default "unknown" as not set, so the file can answer', () => {
    expect(resolveAppCommit({ APP_COMMIT: 'unknown' }, file)).toBe('fedcba9')
    expect(resolveAppCommit({ APP_COMMIT: 'unknown' }, missing)).toBe('unknown')
  })
})

describe('maintenanceRefusal', () => {
  const on = { MAINTENANCE_MODE: '1' }

  it('does nothing unless MAINTENANCE_MODE is exactly 1', () => {
    for (const env of [{}, { MAINTENANCE_MODE: '0' }, { MAINTENANCE_MODE: 'true' }]) {
      expect(isMaintenanceMode(env)).toBe(false)
      expect(maintenanceRefusal(env, 'POST', '/api/app-data')).toBeNull()
    }
    expect(isMaintenanceMode(on)).toBe(true)
  })

  it('(c) lets reads through: pages, API reads and /health', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      for (const pathname of ['/api/app-data', '/staff', '/health']) {
        expect(maintenanceRefusal(on, method, pathname), method + ' ' + pathname).toBeNull()
      }
    }
  })

  it('(a) answers 503 maintenance to every write', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const refusal = maintenanceRefusal(on, method, '/api/app-data')
      expect(refusal?.status).toBe(503)
      expect(refusal?.body).toEqual({
        error: 'maintenance',
        message: 'The app is being moved - try again in a few minutes.',
      })
    }
    expect(maintenanceRefusal(on, 'POST', '/api/voice/post-call')?.status).toBe(503)
  })

  it('(a) refuses the three provider webhooks too, so the providers retry after the switch', () => {
    for (const webhook of ['/api/stripe/webhook', '/api/resend/webhook', '/api/signwell/webhook', '/api/esignatures/webhook']) {
      expect(isProviderWebhookPath(webhook)).toBe(true)
      expect(maintenanceRefusal(on, 'POST', webhook)?.status, webhook).toBe(503)
    }
    expect(isProviderWebhookPath('/api/stripe/webhook/extra')).toBe(false)
    expect(isProviderWebhookPath('/api/app-data')).toBe(false)
  })

  it('lets the sign-in POSTs through so an owner can look around, and nothing else', () => {
    for (const pathname of [
      '/api/auth/sign-in-with-password',
      '/api/auth/request-link',
      '/api/auth/totp/verify',
      '/api/auth/totp/verify-backup',
      '/api/logout',
      '/verify/abc123',
    ]) {
      expect(isAuthenticationPath(pathname), pathname).toBe(true)
      expect(maintenanceRefusal(on, 'POST', pathname), pathname).toBeNull()
    }
    for (const pathname of [
      '/api/auth/change-password',
      '/api/auth/totp/disable',
      '/api/auth/totp/setup-complete',
      '/api/auth/desktop-handoff',
      '/api/auth/sign-in-with-password/extra',
      '/verify/abc/def',
      '/verify/',
      '/api/app-data',
    ]) {
      expect(isAuthenticationPath(pathname), pathname).toBe(false)
      expect(maintenanceRefusal(on, 'POST', pathname)?.status, pathname).toBe(503)
    }
  })

  it('leaves the tick to answer for itself (it skips its jobs instead)', () => {
    expect(maintenanceRefusal(on, 'POST', '/internal/tick')).toBeNull()
  })
})
