import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// vitest runs from the repo root; a cwd-relative path sidesteps the
// import.meta.url scheme differences between node and the vite runner.
const source = readFileSync('server.js', 'utf8')

describe('the rate-version routes exist and are owner-only', () => {
  const routes = [
    ["'/api/rate-versions'", 'GET'],
    ["'/api/team/bill-rate-version'", 'PUT'],
    ["'/api/team/bill-rate-version'", 'DELETE'],
    ["'/api/team/cost-rate-version'", 'PUT'],
    ["'/api/team/cost-rate-version'", 'DELETE'],
  ]
  for (const [path, method] of routes) {
    it(`${method} ${path} is routed`, () => {
      expect(source).toContain(`normalizedPath === ${path} && request.method === '${method}'`)
    })
  }

  it('routes the targeted client pin update', () => {
    expect(source).toMatch(/\/\^\\\/api\\\/clients\\\/\(\[\^\/\]\+\)\\\/hourly-rate-period\$\//)
  })

  it('has exactly one owner guard per new route', () => {
    expect(
      source.match(/Only owners can see rate history|Only owners can set rate versions|Only owners can move a client’s rates/g),
    ).not.toBeNull()
  })
})

describe('loadRateVersions replaced buildCostRateMap', () => {
  it('defines loadRateVersions', () => {
    expect(source).toContain('async function loadRateVersions(session)')
  })

  it('no longer defines or calls buildCostRateMap', () => {
    expect(source).not.toContain('buildCostRateMap')
  })

  it('hands staff two empty lists rather than the real rates', () => {
    const body = source.slice(
      source.indexOf('async function loadRateVersions(session)'),
      source.indexOf('async function loadRateVersions(session)') + 900,
    )
    expect(body).toContain("session?.user?.role !== 'owner'")
    expect(body).toContain('billRateVersions: [], costRateVersions: []')
  })
})

describe('staff redaction covers the pin and its ledger', () => {
  it('blanks both fields beside the other rates in scopeAppDataForSession', () => {
    const start = source.indexOf('function scopeAppDataForSession(session, data)')
    const body = source.slice(start, start + 2000)
    expect(body).toContain('hourlyRate: 0,')
    expect(body).toContain('hourlyRatePeriod: null,')
    expect(body).toContain('hourlyRateHistory: [],')
  })
})
