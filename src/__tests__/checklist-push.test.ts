import { describe, expect, it } from 'vitest'
import {
  canOfferPush,
  canOfferSkip,
  validatePushRequest,
  validateSkipRequest,
} from '../../lib/checklist-skip.js'

/**
 * The push rules, tested where they live (lib/checklist-skip.js) rather than
 * through the surfaces that consume them — the same arrangement as
 * `checklist-skip.test.ts`, and for the same reason: the server, the store and
 * `src/` all import this one module.
 *
 * Push is deliberately skip-plus-a-date. Everything a skip demands, a push
 * demands, which is why most of what is pinned here is that the two agree; the
 * date is the only new rule, and it is the one that stops a "push" from
 * quietly being a backdate or a no-op.
 */

const template = (over: Record<string, unknown> = {}) => ({
  id: 'tmpl-1',
  skipAllowed: true,
  ...over,
})

const instance = (over: Record<string, unknown> = {}) => ({
  id: 'cl-1',
  templateId: 'tmpl-1',
  dueDate: '2026-09-30',
  ...over,
})

const good = {
  category: 'client',
  explanation: 'Statements are late; they promised them next week.',
  newDueDate: '2026-10-31',
}

describe('a push asks for everything a skip asks for', () => {
  it('refuses a request with no category', () => {
    const result = validatePushRequest({ ...good, category: undefined }, instance())
    expect(result.ok).toBe(false)
    // Verbatim the skip refusal — one vocabulary, one wording.
    expect(result.error).toBe(validateSkipRequest({ explanation: good.explanation }).error)
  })

  it('refuses a category outside the three', () => {
    expect(validatePushRequest({ ...good, category: 'weather' }, instance()).ok).toBe(false)
  })

  it('refuses an empty explanation, and whitespace is empty', () => {
    expect(validatePushRequest({ ...good, explanation: '' }, instance()).ok).toBe(false)
    expect(validatePushRequest({ ...good, explanation: '   ' }, instance()).ok).toBe(false)
  })

  it('returns the normalized values so the server never re-trims', () => {
    const result = validatePushRequest(
      { ...good, explanation: '  Waiting on the bank.  ' },
      instance(),
    )
    expect(result).toMatchObject({
      ok: true,
      error: null,
      category: 'client',
      explanation: 'Waiting on the bank.',
      newDueDate: '2026-10-31',
    })
  })
})

describe('the new date is the rule a skip does not have', () => {
  it('refuses a missing date', () => {
    expect(validatePushRequest({ ...good, newDueDate: undefined }, instance()).ok).toBe(false)
    expect(validatePushRequest({ ...good, newDueDate: '   ' }, instance()).ok).toBe(false)
  })

  it('refuses anything that is not yyyy-mm-dd', () => {
    for (const bad of ['10/31/2026', '2026-10', 'next month', '2026-10-31T00:00:00Z']) {
      expect(validatePushRequest({ ...good, newDueDate: bad }, instance()).ok).toBe(false)
    }
  })

  it('refuses a date that is well-formed but not a real day', () => {
    expect(validatePushRequest({ ...good, newDueDate: '2026-02-30' }, instance()).ok).toBe(false)
    expect(validatePushRequest({ ...good, newDueDate: '2026-13-01' }, instance()).ok).toBe(false)
    // …and accepts the leap day that actually exists.
    expect(
      validatePushRequest({ ...good, newDueDate: '2028-02-29' }, instance({ dueDate: '2028-01-31' }))
        .ok,
    ).toBe(true)
  })

  it('refuses the date it is already due on — a push has to move it', () => {
    const result = validatePushRequest({ ...good, newDueDate: '2026-09-30' }, instance())
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/after the one it is due on now/i)
  })

  it('refuses an earlier date — pushing only ever moves forward', () => {
    expect(validatePushRequest({ ...good, newDueDate: '2026-09-01' }, instance()).ok).toBe(false)
  })

  it('accepts the next day, and any date beyond it', () => {
    expect(validatePushRequest({ ...good, newDueDate: '2026-10-01' }, instance()).ok).toBe(true)
    expect(validatePushRequest({ ...good, newDueDate: '2027-01-15' }, instance()).ok).toBe(true)
  })

  // The other end of the same rule. A mistyped year in the date field is one
  // keystroke, and a push moves only the WORKING date — the row keeps its
  // identity on the cycle it came from, so a task parked decades out is simply
  // gone from every list, with nothing downstream to notice.
  it('accepts a push up to two years out', () => {
    expect(validatePushRequest({ ...good, newDueDate: '2028-09-30' }, instance()).ok).toBe(true)
  })

  it('refuses a push further than two years out', () => {
    const result = validatePushRequest({ ...good, newDueDate: '2028-10-01' }, instance())
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/within two years/i)
  })

  it('refuses a mistyped year outright', () => {
    expect(validatePushRequest({ ...good, newDueDate: '2226-10-31' }, instance()).ok).toBe(false)
  })
})

describe('who is offered a push', () => {
  it('is the same gate as skipping — one owner setting governs both', () => {
    const templates = [template()]
    const args = { checklist: instance(), templates, canWrite: true }
    expect(canOfferPush(args)).toBe(canOfferSkip(args))
    expect(canOfferPush(args)).toBe(true)
  })

  it('offers nothing when the template has skipping turned off', () => {
    const templates = [template({ skipAllowed: false })]
    expect(canOfferPush({ checklist: instance(), templates, canWrite: true })).toBe(false)
  })

  it('offers nothing on a one-off task — there is no cycle to keep a place in', () => {
    expect(
      canOfferPush({
        checklist: instance({ templateId: undefined }),
        templates: [template()],
        canWrite: true,
      }),
    ).toBe(false)
  })

  it('offers nothing to a viewer who cannot write the task', () => {
    expect(canOfferPush({ checklist: instance(), templates: [template()], canWrite: false })).toBe(
      false,
    )
  })

  it('offers nothing once the occurrence has been skipped — it is closed out', () => {
    expect(
      canOfferPush({
        checklist: instance({ skippedAt: '2026-09-14T10:00:00.000Z' }),
        templates: [template()],
        canWrite: true,
      }),
    ).toBe(false)
  })
})
