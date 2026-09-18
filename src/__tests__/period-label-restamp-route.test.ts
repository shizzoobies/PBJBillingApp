import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * The bulk save has to re-stamp the period labels of any recipe whose covered
 * window it just carried — featreq-053fccba.
 *
 * WHERE THIS LIVES AND WHY. A recipe's period fields have no endpoint of their
 * own: they ride `PUT /api/app-data` like every other template edit, so that
 * route is where "she corrected the window" lands. The decision itself is
 * tested properly, both backends, in db/store-staleness.test.mjs; `server.js`
 * calls `listen()` at module scope and exports nothing, so what is pinned here
 * is the GLUE — the call is present, it runs on the templates that carry a
 * window, and it happens BEFORE the fingerprint is computed. Treat a failure
 * here as "the route moved, go look".
 */

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
  'utf8',
)

const block = () => {
  const at = serverSource.indexOf('[bulk-save] re-stamped')
  expect(at, 're-stamp block not found in the app-data route').toBeGreaterThan(-1)
  return serverSource.slice(at - 2500, at + 500)
}

describe('the bulk save re-stamps the period labels it may have moved', () => {
  it('calls the store per template', () => {
    expect(block()).toContain('appDataStore.restampPeriodLabelsForTemplate(template.id)')
  })

  it('considers every recipe that CARRIES a window, not only the enabled ones', () => {
    // Switching the label off has to clear the open instances, so the filter
    // cannot be `periodLabelEnabled` alone.
    const text = block()
    expect(text).toContain('template.periodLabelEnabled === true ||')
    expect(text).toContain('Boolean(template.periodCoverageStart)')
    expect(text).toContain('Boolean(template.periodCoverageAnchorDue)')
  })

  it('logs how many labels moved', () => {
    expect(block()).toMatch(/console\.log\(`\[bulk-save\] re-stamped \${restampedLabels} period label/)
  })

  it('never lets a label failure fail an accepted save', () => {
    const text = block()
    const callAt = text.indexOf('restampPeriodLabelsForTemplate')
    expect(text.slice(callAt - 200, callAt)).toContain('try {')
    expect(text.slice(callAt, callAt + 300)).toContain('} catch (error) {')
  })

  it('re-stamps BEFORE the fingerprint is computed, or the tab 409s against us', () => {
    const restampAt = serverSource.indexOf('restampPeriodLabelsForTemplate(template.id)')
    const versionAt = serverSource.indexOf(
      'const nextVersion = await appDataStore.computeWorkspaceVersion()',
    )
    expect(restampAt).toBeGreaterThan(-1)
    expect(versionAt).toBeGreaterThan(restampAt)
  })
})
