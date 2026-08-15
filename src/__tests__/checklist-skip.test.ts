import { describe, expect, it } from 'vitest'
import {
  SKIP_REASON_CATEGORIES,
  canOfferSkip,
  isChecklistSkipped,
  isSkipAllowedForChecklist,
  pendingSkipReviews,
  skipNotificationRecipients,
  validateSkipRequest,
} from '../../lib/checklist-skip.js'

/**
 * The quiet-skip rules, tested where they live (lib/checklist-skip.js) rather
 * than through the three surfaces that consume them. The server, the store and
 * `src/` all import this one module, so a rule proved here is proved everywhere.
 */

const template = (over: Record<string, unknown> = {}) => ({
  id: 'tmpl-1',
  skipAllowed: true,
  ...over,
})

const instance = (over: Record<string, unknown> = {}) => ({
  id: 'cl-1',
  templateId: 'tmpl-1',
  ...over,
})

describe('skippable is a property set at creation', () => {
  it('refuses a task whose template has skipping turned off', () => {
    const templates = [template({ skipAllowed: false })]
    expect(isSkipAllowedForChecklist(instance(), templates)).toBe(false)
    expect(canOfferSkip({ checklist: instance(), templates, canWrite: true })).toBe(false)
  })

  it('defaults to off when the template never carried the flag at all', () => {
    const templates = [{ id: 'tmpl-1' }]
    expect(isSkipAllowedForChecklist(instance(), templates)).toBe(false)
  })

  it('allows it once an owner turns it on', () => {
    const templates = [template()]
    expect(isSkipAllowedForChecklist(instance(), templates)).toBe(true)
    expect(canOfferSkip({ checklist: instance(), templates, canWrite: true })).toBe(true)
  })

  it('never offers skipping on a one-off task — there is no next occurrence', () => {
    const templates = [template()]
    expect(isSkipAllowedForChecklist(instance({ templateId: undefined }), templates)).toBe(false)
  })

  it('offers nothing to a viewer who cannot write the task', () => {
    expect(canOfferSkip({ checklist: instance(), templates: [template()], canWrite: false })).toBe(
      false,
    )
  })

  it('offers nothing on a task already skipped this cycle', () => {
    const checklist = instance({ skippedAt: '2026-08-14T10:00:00.000Z' })
    expect(isChecklistSkipped(checklist)).toBe(true)
    expect(canOfferSkip({ checklist, templates: [template()], canWrite: true })).toBe(false)
  })
})

describe('the skip form', () => {
  it('is exactly three categories — me, a colleague, the client', () => {
    expect(SKIP_REASON_CATEGORIES.map((option) => option.value)).toEqual([
      'me',
      'colleague',
      'client',
    ])
  })

  it.each(['me', 'colleague', 'client'])('accepts and preserves the %s category', (category) => {
    const result = validateSkipRequest({ category, explanation: 'Bank feed was down all week.' })
    expect(result.ok).toBe(true)
    expect(result.ok && result.category).toBe(category)
  })

  it('refuses a category outside the three', () => {
    const result = validateSkipRequest({ category: 'weather', explanation: 'It rained.' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('you, a colleague, or the client')
  })

  it('refuses an empty explanation, and whitespace is empty', () => {
    expect(validateSkipRequest({ category: 'me', explanation: '' }).error).toContain(
      'short explanation',
    )
    expect(validateSkipRequest({ category: 'me', explanation: '   \n  ' }).ok).toBe(false)
  })

  it('trims the explanation it hands back so the caller never re-trims', () => {
    const result = validateSkipRequest({ category: 'client', explanation: '  no statements  ' })
    expect(result.ok && result.explanation).toBe('no statements')
  })
})

describe('who hears about a skip', () => {
  const OWNER = 'emp-owner'
  const ACCOUNTANT = 'emp-acct'
  const OTHER_ACCOUNTANT = 'emp-acct-2'
  const BOOKKEEPER = 'emp-book'

  const employees = [
    { id: OWNER, role: 'Owner' },
    { id: ACCOUNTANT, role: 'Accountant' },
    { id: OTHER_ACCOUNTANT, role: 'Accountant' },
    { id: BOOKKEEPER, role: 'Bookkeeper' },
  ]
  /** The accountant and the bookkeeper are staffed on this one together. */
  const sharedClient = { assignedBookkeeperIds: [ACCOUNTANT, BOOKKEEPER] }

  it('notifies the owner every time', () => {
    const recipients = skipNotificationRecipients({
      client: sharedClient,
      employees,
      skipperId: BOOKKEEPER,
    })
    expect(recipients).toContain(OWNER)
  })

  it('notifies an accountant staffed on the same client', () => {
    const recipients = skipNotificationRecipients({
      client: sharedClient,
      employees,
      skipperId: BOOKKEEPER,
    })
    expect(recipients).toContain(ACCOUNTANT)
  })

  it('leaves out an accountant who is not on that client', () => {
    const recipients = skipNotificationRecipients({
      client: sharedClient,
      employees,
      skipperId: BOOKKEEPER,
    })
    expect(recipients).not.toContain(OTHER_ACCOUNTANT)
  })

  it('tells no accountant when the skipper is not a bookkeeper', () => {
    const recipients = skipNotificationRecipients({
      client: sharedClient,
      employees,
      skipperId: ACCOUNTANT,
    })
    expect(recipients).toEqual([OWNER])
  })

  it('never notifies the person doing the skipping', () => {
    const recipients = skipNotificationRecipients({
      client: { assignedBookkeeperIds: [OWNER] },
      employees,
      skipperId: OWNER,
    })
    expect(recipients).not.toContain(OWNER)
  })
})

describe('the owner’s review list', () => {
  const skip = (over: Record<string, unknown>) => ({
    id: 'skip-1',
    skippedAt: '2026-08-10T10:00:00.000Z',
    reviewedAt: null,
    ...over,
  })

  it('shows this year’s unreviewed skips, newest first', () => {
    const rows = pendingSkipReviews(
      [
        skip({ id: 'older', skippedAt: '2026-02-01T10:00:00.000Z' }),
        skip({ id: 'newer', skippedAt: '2026-08-01T10:00:00.000Z' }),
      ],
      2026,
    )
    expect(rows.map((row) => row.id)).toEqual(['newer', 'older'])
  })

  it('drops a reviewed skip from the dashboard WITHOUT dropping the record', () => {
    const records = [
      skip({ id: 'pending' }),
      skip({ id: 'handled', reviewedAt: '2026-08-12T09:00:00.000Z', reviewedBy: 'emp-owner' }),
    ]
    expect(pendingSkipReviews(records, 2026).map((row) => row.id)).toEqual(['pending'])
    // The list it was filtered out of is untouched — reviewing is a stamp, not
    // a delete. This is an audit trail.
    expect(records).toHaveLength(2)
    expect(records[1].reviewedAt).toBe('2026-08-12T09:00:00.000Z')
  })

  it('is scoped to the year asked for', () => {
    const rows = pendingSkipReviews([skip({ skippedAt: '2025-12-31T10:00:00.000Z' })], 2026)
    expect(rows).toHaveLength(0)
  })
})
