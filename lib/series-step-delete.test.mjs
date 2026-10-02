import { describe, expect, it } from 'vitest'

import {
  KEPT_REASON_OPEN_WAIT,
  KEPT_REASON_WORK_STARTED,
  LAST_RECURRING_STEP_MESSAGE,
  keptNoticeSentence,
  keptReasonEntry,
  keptReasonText,
  runSeriesStepDelete,
  normalizedLabelSql,
  normalizeStepLabel,
  pickCopyToRemove,
  sameLabelOrdinal,
  stepCarriesWork,
  stepHasOpenSavedWait,
  untouchedStepSql,
} from './series-step-delete.js'

describe('stepCarriesWork', () => {
  const step = (over = {}) => ({ id: 's', label: 'Reconcile', done: false, ...over })
  const wait = { id: 'w', blockerId: 'e2', requestedBy: 'e1', createdAt: '2026-09-01T00:00:00Z' }
  const sub = (over = {}) => ({ id: 'a', title: 'a', done: false, ...over })

  it('an untouched step carries nothing', () => {
    expect(stepCarriesWork(step())).toBe(false)
    expect(stepCarriesWork(step({ waiting: false, waitingOn: '', waitingOns: [], subItems: [] }))).toBe(false)
    expect(stepCarriesWork(step({ subItems: [sub({ subItems: [sub({ id: 'b' })] })] }))).toBe(false)
  })

  it('a done step carries work', () => {
    expect(stepCarriesWork(step({ done: true }))).toBe(true)
  })

  it('every kind of wait on the step carries work, a verified one included', () => {
    expect(stepCarriesWork(step({ waiting: true }))).toBe(true)
    expect(stepCarriesWork(step({ waitingOn: 'bank statements' }))).toBe(true)
    expect(stepCarriesWork(step({ waitingForChecklistId: 'cl-other' }))).toBe(true)
    expect(stepCarriesWork(step({ waitingOns: [wait] }))).toBe(true)
    expect(stepCarriesWork(step({ waitingOns: [{ ...wait, resolvedAt: 'x', verifiedAt: 'y' }] }))).toBe(true)
  })

  it('a done or waiting descendant, at either depth, carries work', () => {
    expect(stepCarriesWork(step({ subItems: [sub({ done: true })] }))).toBe(true)
    expect(stepCarriesWork(step({ subItems: [sub({ subItems: [sub({ id: 'b', done: true })] })] }))).toBe(true)
    expect(stepCarriesWork(step({ subItems: [sub({ waiting: true })] }))).toBe(true)
    expect(stepCarriesWork(step({ subItems: [sub({ waitingOn: 'x' })] }))).toBe(true)
    expect(stepCarriesWork(step({ subItems: [sub({ subItems: [sub({ id: 'b', waitingOns: [wait] })] })] }))).toBe(true)
    expect(stepCarriesWork(step({ subItems: [sub({ waitingForChecklistId: 'cl' })] }))).toBe(true)
  })
})

describe('untouchedStepSql', () => {
  const sql = untouchedStepSql('ci')

  it('states every condition stepCarriesWork checks', () => {
    expect(sql).toMatch(/ci\.done = false/)
    expect(sql).toMatch(/ci\.waiting = false/)
    expect(sql).toMatch(/ci\.waiting_ons = '\[\]'::jsonb/)
    expect(sql).toMatch(/coalesce\(ci\.waiting_on, ''\) = ''/)
    expect(sql).toMatch(/coalesce\(ci\.waiting_for_checklist_id, ''\) = ''/)
    expect(sql).toMatch(/not jsonb_path_exists\(ci\.sub_items, '\$\.\*\* \? \(/)
  })

  it('looks for the same things at every depth of the sub_items JSONB', () => {
    const path = sql.slice(sql.indexOf("'$.**"))
    expect(path).toContain('@.done == true')
    expect(path).toContain('@.waiting == true')
    expect(path).toContain('exists(@.waitingOns[0])')
    // The "s" flag lets `.` match a newline, so a value holding only a newline
    // counts as a wait here exactly as the JavaScript predicate (`!== ''`) says.
    expect(path).toContain('@.waitingOn like_regex "." flag "s"')
    expect(path).toContain('@.waitingForChecklistId like_regex "." flag "s"')
  })

  it('uses the alias it is given', () => {
    expect(untouchedStepSql('x')).toMatch(/x\.waiting = false/)
    expect(untouchedStepSql('x')).not.toMatch(/ci\./)
  })
})

describe('label normalization', () => {
  it('trims and lowercases, including newline and non-breaking-space tails', () => {
    expect(normalizeStepLabel('  Reconcile ')).toBe('reconcile')
    expect(normalizeStepLabel('Reconcile\n')).toBe('reconcile')
    expect(normalizeStepLabel('Reconcile\u00a0')).toBe('reconcile')
    expect(normalizeStepLabel(undefined)).toBe('')
  })

  it('the SQL form strips the same whitespace set, newline and NBSP included', () => {
    const sql = normalizedLabelSql('ci.label')
    expect(sql.startsWith('lower(regexp_replace(ci.label, ')).toBe(true)
    expect(sql).toContain('\\s')
    expect(sql).toContain('\\u00a0')
    expect(sql).toContain('\\ufeff')
    expect(sql.endsWith(", '', 'g'))")).toBe(true)
    // Every whitespace character JS trims is covered by the class the SQL carries.
    const cls = sql.match(/\^\[(.*?)\]\+\|/)[1]
    const re = new RegExp('^[' + cls + ']$')
    for (const ch of ['\n', '\r', '\t', '\u00a0', '\u1680', '\u2003', '\u2028', '\u202f', '\u3000', '\ufeff']) {
      expect(ch.trim()).toBe('')
      expect(re.test(ch)).toBe(true)
    }
  })
})

describe('sameLabelOrdinal and pickCopyToRemove', () => {
  const steps = [
    { id: 'a', label: 'Reconcile' },
    { id: 'b', label: 'Review' },
    { id: 'c', label: ' reconcile ' },
  ]
  const copy = (id, carriesWork = false) => ({ id, carriesWork })

  it('is the position among same-label steps, -1 when absent', () => {
    expect(sameLabelOrdinal(steps, 'a')).toBe(0)
    expect(sameLabelOrdinal(steps, 'c')).toBe(1)
    expect(sameLabelOrdinal(steps, 'b')).toBe(0)
    expect(sameLabelOrdinal(steps, 'zzz')).toBe(-1)
  })

  it('removes the copy at the same ordinal when it is untouched', () => {
    expect(pickCopyToRemove([copy('x'), copy('y')], 1, 2)).toEqual({ removeId: 'y', kept: false })
    // Fewer copies than the template stage had does not matter when the ordinal copy is there.
    expect(pickCopyToRemove([copy('x'), copy('y')], 1, 5)).toEqual({ removeId: 'y', kept: false })
  })

  describe('falling back to another untouched copy', () => {
    it('does so when the checklist has as many copies as the template stage had', () => {
      expect(pickCopyToRemove([copy('x', true), copy('y')], 4, 2)).toEqual({ removeId: 'y', kept: false })
      expect(pickCopyToRemove([copy('x'), copy('y'), copy('z')], 5, 2)).toEqual({ removeId: 'x', kept: false })
    })

    it('does NOT when the checklist has fewer: that copy may be the counterpart of a template step that stays', () => {
      // The template stage had two same-label steps and this checklist has one.
      expect(pickCopyToRemove([copy('x')], 1, 2)).toEqual({ removeId: null, kept: false })
      expect(pickCopyToRemove([copy('x'), copy('y')], 4, 3)).toEqual({ removeId: null, kept: false })
    })
  })

  describe('reporting a checklist as kept', () => {
    it('is only when nothing was removed from it and a copy carries work', () => {
      expect(pickCopyToRemove([copy('x', true)], 0, 1)).toEqual({
        removeId: null,
        kept: true,
        keptReason: KEPT_REASON_WORK_STARTED,
      })
      // The conservative fallback was refused and the copy at the ordinal has work.
      expect(pickCopyToRemove([copy('x'), copy('y', true)], 1, 3)).toEqual({
        removeId: null,
        kept: true,
        keptReason: KEPT_REASON_WORK_STARTED,
      })
    })

    it('says WHY: an open saved wait on a kept copy, else work that had started', () => {
      const waiting = { id: 'x', carriesWork: true, hasOpenWait: true }
      expect(pickCopyToRemove([waiting], 0, 1).keptReason).toBe(KEPT_REASON_OPEN_WAIT)
      // The copy at the clicked ordinal decides, when there is one...
      expect(pickCopyToRemove([copy('y', true), waiting], 0, 3).keptReason).toBe(KEPT_REASON_WORK_STARTED)
      expect(pickCopyToRemove([copy('y', true), waiting], 1, 3).keptReason).toBe(KEPT_REASON_OPEN_WAIT)
      // ...and only when there is none do the others decide: any open wait among them.
      expect(pickCopyToRemove([copy('y', true), waiting], 5, 3).keptReason).toBe(KEPT_REASON_OPEN_WAIT)
      expect(pickCopyToRemove([copy('y', true), copy('z', true)], 5, 3).keptReason).toBe(KEPT_REASON_WORK_STARTED)
      // A flag that is not an open wait (hasOpenWait false or absent) is just work.
      expect(pickCopyToRemove([{ id: 'x', carriesWork: true, hasOpenWait: false }], 0, 1).keptReason).toBe(
        KEPT_REASON_WORK_STARTED,
      )
      // A removed or untouched checklist has no reason at all.
      expect(pickCopyToRemove([copy('x')], 0, 1)).not.toHaveProperty('keptReason')
    })

    it('is never when a copy was removed, so a checklist is not in both lists', () => {
      // The copy at the clicked ordinal has work, another untouched one goes: removed, not kept.
      expect(pickCopyToRemove([copy('x'), copy('y', true)], 1, 2)).toEqual({ removeId: 'x', kept: false })
      // The ordinal copy is untouched and goes; another carries work.
      expect(pickCopyToRemove([copy('x', true), copy('y')], 1, 2)).toEqual({ removeId: 'y', kept: false })
    })

    it('is not when nothing carries work and the fallback was simply declined', () => {
      expect(pickCopyToRemove([copy('x')], 1, 2)).toEqual({ removeId: null, kept: false })
    })
  })

  it('has nothing to say about a checklist with no copy', () => {
    expect(pickCopyToRemove([], 0, 1)).toEqual({ removeId: null, kept: false })
  })
})

describe('LAST_RECURRING_STEP_MESSAGE', () => {
  it('is the sentence the owner reads', () => {
    expect(LAST_RECURRING_STEP_MESSAGE).toBe(
      'This is the last step of the recurring checklist. Delete or pause the recurring checklist instead.',
    )
  })
})

describe('stepHasOpenSavedWait', () => {
  const wait = { id: 'w', blockerId: 'e2', requestedBy: 'e1', createdAt: '2026-09-01T00:00:00Z' }
  const verified = { ...wait, resolvedAt: '2026-09-02T00:00:00Z', verifiedAt: '2026-09-03T00:00:00Z' }

  it('is true for an open saved wait on the step or anywhere beneath it', () => {
    expect(stepHasOpenSavedWait({ waitingOns: [wait] })).toBe(true)
    expect(stepHasOpenSavedWait({ subItems: [{ id: 'a', title: 'a', waitingOns: [wait] }] })).toBe(true)
    expect(
      stepHasOpenSavedWait({
        subItems: [{ id: 'a', title: 'a', subItems: [{ id: 'b', title: 'b', waitingOns: [wait] }] }],
      }),
    ).toBe(true)
  })

  it('is false for a closed wait, a bare flag, a done step or nothing', () => {
    expect(stepHasOpenSavedWait({ waitingOns: [verified] })).toBe(false)
    expect(stepHasOpenSavedWait({ waiting: true, waitingOn: 'the bank' })).toBe(false)
    expect(stepHasOpenSavedWait({ done: true })).toBe(false)
    expect(stepHasOpenSavedWait({})).toBe(false)
  })
})

describe('keptReasonEntry', () => {
  it('names the checklist by its month and orders it by the occurrence it belongs to', () => {
    expect(keptReasonEntry('cl-nov', 'open_wait', { cycleDueDate: '2026-11-30', dueDate: '2026-12-03' })).toEqual({
      checklistId: 'cl-nov',
      reason: 'open_wait',
      label: 'November 2026',
      occurrence: '2026-11-30',
    })
    expect(keptReasonEntry('x', 'work_started', null)).toEqual({
      checklistId: 'x',
      reason: 'work_started',
      label: null,
      occurrence: null,
    })
  })
})

describe('the words for kept copies', () => {
  it('names the reason', () => {
    expect(keptReasonText(KEPT_REASON_OPEN_WAIT)).toBe('an open wait')
    expect(keptReasonText(KEPT_REASON_WORK_STARTED)).toBe('work had started')
    expect(keptReasonText(undefined)).toBe('work had started')
  })

  it('writes one sentence naming each kept month and why', () => {
    expect(keptNoticeSentence([])).toBe('')
    expect(keptNoticeSentence(undefined)).toBe('')
    expect(keptNoticeSentence([{ label: 'November 2026', reason: KEPT_REASON_OPEN_WAIT }])).toBe(
      'Kept on November 2026 (an open wait).',
    )
    expect(
      keptNoticeSentence([
        { label: 'November 2026', reason: KEPT_REASON_OPEN_WAIT },
        { label: 'December 2026', reason: KEPT_REASON_WORK_STARTED },
      ]),
    ).toBe('Kept on November 2026 (an open wait) and December 2026 (work had started).')
    expect(
      keptNoticeSentence([
        { label: 'October 2026', reason: KEPT_REASON_WORK_STARTED },
        { label: 'November 2026', reason: KEPT_REASON_OPEN_WAIT },
        { label: null, reason: KEPT_REASON_WORK_STARTED },
      ]),
    ).toBe(
      'Kept on October 2026 (work had started), November 2026 (an open wait), and a later checklist (work had started).',
    )
  })

  it('collapses into counts by reason when none of them can be named (an older server)', () => {
    const none = (reason) => ({ label: null, reason })
    expect(keptNoticeSentence([none('work_started'), none('work_started'), none('work_started')])).toBe(
      'Kept on 3 later checklists (work had started).',
    )
    expect(keptNoticeSentence([none('work_started')])).toBe('Kept on 1 later checklist (work had started).')
    expect(keptNoticeSentence([none('work_started'), none('open_wait'), none('work_started')])).toBe(
      'Kept on 2 later checklists (work had started) and 1 later checklist (an open wait).',
    )
  })
})

describe('runSeriesStepDelete hands back only what changed', () => {
  const fakeStore = (removal) => ({
    deleteChecklistItemFromSeries: async () => removal,
    recordActivity: async () => {},
    read: async () => ({
      checklists: ['cl-sep', 'cl-oct', 'cl-nov', 'cl-dec'].map((id) => ({ id, title: id })),
      checklistTemplates: [{ id: 'tmpl-1' }],
    }),
  })

  it('does not return a kept checklist to be merged (it would replace an unsaved local edit); it names it in keptReasons', async () => {
    const keptReasons = [keptReasonEntry('cl-oct', 'open_wait', { dueDate: '2026-10-31' })]
    const result = await runSeriesStepDelete({
      store: fakeStore({
        removedFromTemplate: true,
        removedFromChecklists: ['cl-nov'],
        keptOnChecklists: ['cl-oct'],
        keptReasons,
      }),
      actorId: 'owner',
      broadcast: () => {},
      checklist: { id: 'cl-sep', title: 'Close', templateId: 'tmpl-1' },
      itemId: 's1',
      label: 'Reconcile',
    })
    expect(result.status).toBe(200)
    expect(result.body.checklists.map((entry) => entry.id).sort()).toEqual(['cl-nov', 'cl-sep'])
    expect(result.body.keptReasons).toEqual([
      { checklistId: 'cl-oct', reason: 'open_wait', label: 'October 2026', occurrence: '2026-10-31' },
    ])
  })
})
