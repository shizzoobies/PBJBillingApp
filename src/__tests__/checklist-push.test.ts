import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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

/**
 * featreq-68638ed2, sent back: "I cannot find the push button."
 *
 * It shipped sharing skipping's per-template `skipAllowed` opt-in, which is on
 * 6 of 150 active templates — so the button existed on 4% of tasks. Moving a
 * date is not stepping past work, so it needs no per-recipe permission. The
 * only gate left is "can this person edit this task".
 */
describe('who is offered a push', () => {
  it('is offered on every task the viewer can edit, whatever the template says', () => {
    expect(
      canOfferPush({ checklist: instance(), templates: [template()], canWrite: true }),
    ).toBe(true)
    expect(
      canOfferPush({
        checklist: instance(),
        templates: [template({ skipAllowed: false })],
        canWrite: true,
      }),
    ).toBe(true)
  })

  it('no longer follows skipping — a task that cannot be SKIPPED can still be pushed', () => {
    const args = { checklist: instance(), templates: [template({ skipAllowed: false })], canWrite: true }
    expect(canOfferSkip(args)).toBe(false)
    expect(canOfferPush(args)).toBe(true)
  })

  it('is offered on a ONE-OFF task — the dialog falls back to a month out', () => {
    expect(
      canOfferPush({
        checklist: instance({ templateId: undefined }),
        templates: [template()],
        canWrite: true,
      }),
    ).toBe(true)
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

  it('SKIPPING is unchanged — it still rides the template opt-in', () => {
    expect(canOfferSkip({ checklist: instance(), templates: [template()], canWrite: true })).toBe(
      true,
    )
    expect(
      canOfferSkip({
        checklist: instance({ templateId: undefined }),
        templates: [template()],
        canWrite: true,
      }),
    ).toBe(false)
  })
})

/**
 * The endpoint has to agree with the button, or a task that shows Push refuses
 * it. `server.js` listens at module scope and exports nothing, so the two
 * routes are pinned by reading their source (the arrangement used throughout
 * this suite).
 */
describe('the push endpoint drops the opt-in the skip endpoint keeps', () => {
  const serverSource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server.js'),
    'utf8',
  )
  const routeBlock = (startPattern: RegExp, length = 2200): string => {
    const at = serverSource.search(startPattern)
    expect(at, `route not found: ${startPattern}`).toBeGreaterThan(-1)
    return serverSource.slice(at, at + length)
  }

  it('the push route has no skipAllowed gate, but keeps write permission and the 409', () => {
    const block = routeBlock(/const checklistPushMatch = normalizedPath\.match/)
    expect(block).not.toContain('isSkipAllowedForChecklist')
    expect(block).toContain('checklistWriteDenial(')
    expect(block).toContain('SKIP_ALREADY_SKIPPED_MESSAGE')
  })

  it('the skip route still refuses a task whose template has skipping off', () => {
    const block = routeBlock(/const checklistSkipMatch = normalizedPath\.match/)
    expect(block).toContain('isSkipAllowedForChecklist(checklist, data.checklistTemplates ?? [])')
    expect(block).toContain('SKIP_NOT_ENABLED_MESSAGE')
  })
})
