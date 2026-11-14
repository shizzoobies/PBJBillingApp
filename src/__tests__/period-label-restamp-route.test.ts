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

  it('re-takes the fingerprint AFTER a restamp that changed rows, or the tab 409s against us', () => {
    const restampAt = serverSource.indexOf('restampPeriodLabelsForTemplate(template.id)')
    const retakeAt = serverSource.indexOf('if (restampedLabels > 0 && !versionFailed) {')
    const versionAt = serverSource.indexOf('nextVersion = await appDataStore.computeWorkspaceVersion()', retakeAt)
    expect(restampAt).toBeGreaterThan(-1)
    expect(versionAt).toBeGreaterThan(restampAt)
  })
})

/**
 * Covered dates set by hand on one checklist - featreq-6678d532. Same reason
 * for pinning the glue: the decision is tested in the store, both backends;
 * what can silently move here is WHO may ask and WHAT the answer carries.
 */
describe('PATCH /api/checklists/:id takes covered dates', () => {
  const route = () => {
    const at = serverSource.indexOf("if (checklistMetaPatchMatch && request.method === 'PATCH') {")
    expect(at, 'the edit-details route was not found').toBeGreaterThan(-1)
    const end = serverSource.indexOf('// DELETE /api/checklists/:id', at)
    return serverSource.slice(at, end)
  }

  it('is behind the same gate as every other edit of the task', () => {
    const text = route()
    const gateAt = text.indexOf('checklistWriteDenial({')
    const writeAt = text.indexOf('appDataStore.setCasePeriodLabel(checklistId, coveredDates)')
    expect(gateAt).toBeGreaterThan(-1)
    expect(writeAt).toBeGreaterThan(gateAt)
  })

  it('refuses dates that are not a window before anything is written', () => {
    const text = route()
    const checkAt = text.indexOf('if (!periodLabelFromDates(start, end)) {')
    expect(checkAt).toBeGreaterThan(-1)
    expect(checkAt).toBeLessThan(text.indexOf('appDataStore.updateChecklistMeta('))
    expect(text).toContain('Pick both covered dates, with the first on or before the second.')
  })

  it('tells "leave the dates alone" (no key) from "use the recipe\'s dates" (null)', () => {
    const text = route()
    expect(text).toContain("if ('coveredDates' in payload) {")
    expect(text).toContain('if (payload.coveredDates === null) {')
    expect(text).toContain('if (coveredDates !== undefined) {')
    expect(text).toContain('Object.keys(proposed).length === 0 && coveredDates === undefined')
  })

  it('answers with the other steps by id and label only', () => {
    const text = route()
    const at = text.indexOf('caseLabels = relabeled.caseChecklists.map((entry) => ({')
    expect(at).toBeGreaterThan(-1)
    const shape = text.slice(at, text.indexOf('}))', at))
    expect(shape.match(/^\s+\w+:/gm)?.map((line) => line.trim())).toEqual([
      'id:',
      'periodLabel:',
      'periodLabelManual:',
    ])
  })
})
