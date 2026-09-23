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
    // SIX, one per route Task 6 added: GET /api/rate-versions, PUT and DELETE
    // on each of bill- and cost-rate-version, and PUT
    // /api/clients/:id/hourly-rate-period. A bare `not.toBeNull()` on a global
    // match passes while five of the six guards are gone, which is the one
    // failure this test exists to catch — so it counts them.
    const guards = source.match(
      /Only owners can see rate history|Only owners can set rate versions|Only owners can move a client’s rates/g,
    )
    expect(guards, 'every owner guard on the rate-history routes is gone').not.toBeNull()
    expect(guards).toHaveLength(6)
  })

  it('answers 404 for an id that names nobody on both PUT version routes', () => {
    // The store refuses an unknown user SILENTLY, with an empty list — which is
    // also what a real person with no history returns. The roster lookup is the
    // only thing separating the two, so losing it turns a typo into a 200.
    for (const path of ["'/api/team/bill-rate-version'", "'/api/team/cost-rate-version'"]) {
      const start = source.indexOf(`normalizedPath === ${path} && request.method === 'PUT'`)
      expect(start, `${path} PUT route is gone`).toBeGreaterThan(-1)
      const body = source.slice(start, source.indexOf("sendJson(response, 200, { ok: true, userId, versions })", start))
      expect(body).toContain('isKnownTeamMemberId')
      expect(body).toContain("'User not found'")
    }
  })
})

describe('the old undated rate routes can no longer clear every version', () => {
  // An old tab still running the previous bundle across the deploy saves an
  // EMPTIED rate box as null — which the store reads as "delete every
  // version", bypassing the newest-only and pinned-client guards.
  for (const path of ["'/api/team/bill-rate'", "'/api/team/cost-rate'"]) {
    it(`${path} refuses a blank rate with 409 and never calls the store with null`, () => {
      const start = source.indexOf(`normalizedPath === ${path} && request.method === 'PUT'`)
      expect(start, `${path} PUT route is gone`).toBeGreaterThan(-1)
      const end = source.indexOf('normalizedPath ===', start + 40)
      const body = source.slice(start, end > start ? end : start + 3000)
      expect(body).toContain("sendJson(response, 409, {")
      expect(body).toContain("error: 'rate_history_kept'")
      expect(body).toContain(
        'Rates are now kept as dated versions. Remove the newest version from Rate history instead.',
      )
      expect(body).not.toMatch(/setEmployee(Bill|Cost)Rate\(userId, raw === '' \? null : raw\)/)
    })
  }
})

describe('the rate-month move validates the month it is handed', () => {
  it('refuses a month outside 01–12 and any month before per-person billing', () => {
    const start = source.indexOf('const clientRatePeriodMatch = normalizedPath.match(')
    expect(start, 'the pin route is gone').toBeGreaterThan(-1)
    const body = source.slice(start, source.indexOf('appDataStore.setClientHourlyRatePeriod', start))
    expect(body).toContain("error: 'bad_period'")
    expect(body).toContain('PER_EMPLOYEE_BILLING_START')
    expect(body).toMatch(/month < 1 \|\| month > 12/)
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

describe('the AI hours summary mirrors the invoice’s rate rule', () => {
  it('takes the version list and resolves the client’s own pin', () => {
    const start = source.indexOf('function buildInvoiceHoursSummary(data, client, period')
    expect(start, 'buildInvoiceHoursSummary is gone').toBeGreaterThan(-1)
    const body = source.slice(start, start + 2400)
    expect(body).toContain('billRateVersions = []')
    expect(body).toContain('ratePeriodAsOf(client, period)')
    expect(body).toContain('billRateAt(billRateVersions, employeeById.get(employeeId)')
  })

  it('threads the same list into the master variant’s per-sub calls', () => {
    const start = source.indexOf('function buildMasterInvoiceHoursSummary(')
    const body = source.slice(start, start + 1400)
    expect(body).toContain('buildInvoiceHoursSummary(data, sub, period, billRateVersions)')
  })
})
