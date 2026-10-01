import { describe, expect, it } from 'vitest'

import {
  LAST_RECURRING_STEP_MESSAGE,
  normalizedLabelSql,
  normalizeStepLabel,
  pickCopyToRemove,
  sameLabelOrdinal,
  stepCarriesWork,
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
      expect(pickCopyToRemove([copy('x', true)], 0, 1)).toEqual({ removeId: null, kept: true })
      // The conservative fallback was refused and the copy at the ordinal has work.
      expect(pickCopyToRemove([copy('x'), copy('y', true)], 1, 3)).toEqual({ removeId: null, kept: true })
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
