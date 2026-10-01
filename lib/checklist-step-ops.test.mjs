import { describe, expect, it } from 'vitest'

import {
  applyItemToggle,
  applySubItemRemoval,
  applySubSubItemRemoval,
  cascadeSubItem,
  normalizeSubItems,
  normalizeWaitingOns,
} from './checklist-step-ops.js'

/**
 * The pure step math the store writes and the waiting guard simulates. These
 * pin the behavior `db/store.js` had before the math moved here, so a change to
 * it is a change to both the store and the guard on purpose.
 */

const sub = (id, over = {}) => ({ id, title: `Sub ${id}`, done: false, ...over })

describe('applyItemToggle', () => {
  it('flips a flat item', () => {
    expect(applyItemToggle([], false)).toEqual({ subItems: [], done: true })
    expect(applyItemToggle(undefined, true)).toEqual({ subItems: [], done: false })
  })

  it('cascades a top-level tick onto every sub-item and sub-sub-item', () => {
    const next = applyItemToggle(
      [sub('a', { subItems: [sub('a1'), sub('a2')] }), sub('b')],
      false,
    )
    expect(next.done).toBe(true)
    expect(next.subItems.every((s) => s.done)).toBe(true)
    expect(next.subItems[0].subItems.every((s) => s.done)).toBe(true)
  })

  it('un-ticks everything when the whole step is already done', () => {
    const next = applyItemToggle([sub('a', { done: true }), sub('b', { done: true })], true)
    expect(next.done).toBe(false)
    expect(next.subItems.every((s) => !s.done)).toBe(true)
  })

  it('flips one sub-item and rolls the parent up', () => {
    const next = applyItemToggle([sub('a', { done: true }), sub('b')], false, { subItemId: 'b' })
    expect(next.done).toBe(true)
    expect(next.subItems.map((s) => s.done)).toEqual([true, true])
  })

  it('flips one sub-sub-item, then rolls up its sub-item and the item', () => {
    const next = applyItemToggle(
      [sub('a', { subItems: [sub('a1', { done: true }), sub('a2')] })],
      false,
      { subItemId: 'a', subSubItemId: 'a2' },
    )
    expect(next.subItems[0].done).toBe(true)
    expect(next.done).toBe(true)
  })

  it('answers null for a sub-item or sub-sub-item that is not there', () => {
    expect(applyItemToggle([sub('a')], false, { subItemId: 'zzz' })).toBeNull()
    expect(applyItemToggle([sub('a')], false, { subItemId: 'a', subSubItemId: 'zzz' })).toBeNull()
    expect(applyItemToggle([sub('a')], false, { subSubItemId: 'a1' })).toBeNull()
  })

  it('normalizes first: untitled sub-items are dropped and a sub-item rolls up its children', () => {
    const next = applyItemToggle(
      [{ id: 'x', title: '  ', done: false }, sub('a', { done: true, subItems: [sub('a1')] })],
      false,
      { subItemId: 'a', subSubItemId: 'a1' },
    )
    expect(next.subItems.map((s) => s.id)).toEqual(['a'])
    expect(next.done).toBe(true)
  })

  it('does not change what it was given', () => {
    const input = [sub('a', { subItems: [sub('a1')] })]
    const before = JSON.stringify(input)
    applyItemToggle(input, false)
    expect(JSON.stringify(input)).toBe(before)
  })
})

describe('cascadeSubItem', () => {
  it('sets the sub-item and every sub-sub-item beneath it', () => {
    const next = cascadeSubItem(sub('a', { subItems: [sub('a1'), sub('a2')] }), true)
    expect(next.done).toBe(true)
    expect(next.subItems.map((s) => s.done)).toEqual([true, true])
  })
})

describe('applySubItemRemoval', () => {
  it('rolls the parent up from what is left: removing the last open sub-item completes it', () => {
    const next = applySubItemRemoval([sub('a', { done: true }), sub('b')], false, 'b')
    expect(next).toMatchObject({ done: true })
    expect(next.subItems.map((s) => s.id)).toEqual(['a'])
  })

  it('keeps the stored done once no sub-items are left', () => {
    expect(applySubItemRemoval([sub('a')], false, 'a')).toEqual({ subItems: [], done: false })
    expect(applySubItemRemoval([sub('a')], true, 'a')).toEqual({ subItems: [], done: true })
  })

  it('answers null for a sub-item that is not there', () => {
    expect(applySubItemRemoval([sub('a')], false, 'zzz')).toBeNull()
  })
})

describe('applySubSubItemRemoval', () => {
  it('rolls the sub-item up, then the item', () => {
    const next = applySubSubItemRemoval(
      [sub('a', { done: true }), sub('b', { subItems: [sub('b1', { done: true }), sub('b2')] })],
      { subItemId: 'b', subSubItemId: 'b2' },
    )
    expect(next.subItems[1].done).toBe(true)
    expect(next.done).toBe(true)
  })

  it('turns a sub-item with no sub-sub-items left back into a flat one', () => {
    const next = applySubSubItemRemoval([sub('a', { subItems: [sub('a1')] })], {
      subItemId: 'a',
      subSubItemId: 'a1',
    })
    expect(next.subItems[0].subItems).toBeUndefined()
    expect(next.subItems[0].done).toBe(false)
    expect(next.done).toBe(false)
  })

  it('answers null for a sub-item or sub-sub-item that is not there', () => {
    expect(applySubSubItemRemoval([sub('a')], { subItemId: 'zzz', subSubItemId: 'a1' })).toBeNull()
    expect(applySubSubItemRemoval([sub('a')], { subItemId: 'a', subSubItemId: 'a1' })).toBeNull()
  })
})

describe('normalizeSubItems', () => {
  it('keeps the wait fields on live sub-items and mints ids for ones without', () => {
    const [kept] = normalizeSubItems([
      {
        title: ' Chase ',
        waiting: true,
        waitingOn: ' client ',
        waitingOns: [{ blockerId: 'emp-lisa', requestedBy: 'emp-brit' }],
      },
    ])
    expect(kept.title).toBe('Chase')
    expect(kept.id).toMatch(/^subitem-/)
    expect(kept.waiting).toBe(true)
    expect(kept.waitingOn).toBe('client')
    expect(kept.waitingOns).toHaveLength(1)
  })

  it('leaves done off for template items', () => {
    const [kept] = normalizeSubItems([{ id: 'a', title: 'A', done: true }], { withDone: false })
    expect(kept).toEqual({ id: 'a', title: 'A' })
  })
})

describe('normalizeWaitingOns', () => {
  it('drops entries without a blocker or a requester and stamps ids and dates', () => {
    const out = normalizeWaitingOns([
      { blockerId: 'emp-lisa', requestedBy: 'emp-brit', note: ' hi ' },
      { blockerId: 'emp-lisa' },
      null,
    ])
    expect(out).toHaveLength(1)
    expect(out[0].id).toMatch(/^wo-/)
    expect(out[0].note).toBe('hi')
    expect(typeof out[0].createdAt).toBe('string')
  })
})
