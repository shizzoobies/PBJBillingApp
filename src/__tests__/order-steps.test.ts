import { beforeEach, describe, expect, it } from 'vitest'
import {
  hideDoneKey,
  isStepDone,
  orderAfterDrag,
  orderAfterMove,
  orderStepsForDisplay,
  readHideDone,
  writeHideDone,
} from '../lib/orderSteps'

/**
 * Completed-to-bottom is a DISPLAY sort (featreq-8a01fe08): open steps in saved
 * order, then done steps in saved order, and nothing about `done` order is ever
 * persisted. These pin the pure rules the checklist page builds on, including
 * the order math a drag / Move up / Move down sends to the server: the new open
 * order followed by the EXISTING done order.
 */

const step = (id: string, done = false) => ({ id, done })
// Saved order: a(open) b(done) c(open) d(done) e(open)
const saved = [step('a'), step('b', true), step('c'), step('d', true), step('e')]

describe('orderStepsForDisplay', () => {
  it('puts open steps first, then done steps, each in saved order', () => {
    expect(orderStepsForDisplay(saved).map((s) => s.id)).toEqual(['a', 'c', 'e', 'b', 'd'])
  })

  it('leaves an all-open or all-done list exactly as saved', () => {
    expect(orderStepsForDisplay([step('x'), step('y')]).map((s) => s.id)).toEqual(['x', 'y'])
    expect(orderStepsForDisplay([step('x', true), step('y', true)]).map((s) => s.id)).toEqual([
      'x',
      'y',
    ])
  })

  it('does not mutate its input, and returns the same step objects', () => {
    const input = [step('a', true), step('b')]
    const out = orderStepsForDisplay(input)
    expect(input.map((s) => s.id)).toEqual(['a', 'b'])
    expect(out[0]).toBe(input[1])
  })

  it('treats a missing done flag as open and handles an empty list', () => {
    expect(orderStepsForDisplay([{ id: 'a', done: true }, { id: 'b' }]).map((s) => s.id)).toEqual([
      'b',
      'a',
    ])
    expect(orderStepsForDisplay([])).toEqual([])
  })

  // Un-ticking a done step brings it back to where it was SAVED, because the
  // done order is never rewritten.
  it('returns an un-ticked step to its saved slot', () => {
    const reopened = saved.map((s) => (s.id === 'b' ? { ...s, done: false } : s))
    expect(orderStepsForDisplay(reopened).map((s) => s.id)).toEqual(['a', 'b', 'c', 'e', 'd'])
  })
})

describe('orderAfterDrag', () => {
  it('sends the new open order followed by the existing done order', () => {
    // Drag e onto a: open group becomes e, a, c; done group stays b, d.
    expect(orderAfterDrag(saved, 'e', 'a')).toEqual(['e', 'a', 'c', 'b', 'd'])
    // Drag a onto e: open group becomes c, e, a.
    expect(orderAfterDrag(saved, 'a', 'e')).toEqual(['c', 'e', 'a', 'b', 'd'])
  })

  it('works from the DISPLAYED order, the one the user sees', () => {
    // Same answer whichever order the list is handed over in.
    expect(orderAfterDrag(orderStepsForDisplay(saved), 'e', 'c')).toEqual([
      'a',
      'e',
      'c',
      'b',
      'd',
    ])
  })

  it('sends nothing when either end is a done step, unknown, or the same step', () => {
    expect(orderAfterDrag(saved, 'b', 'a')).toBeNull()
    expect(orderAfterDrag(saved, 'a', 'b')).toBeNull()
    expect(orderAfterDrag(saved, 'a', 'zzz')).toBeNull()
    expect(orderAfterDrag(saved, 'zzz', 'a')).toBeNull()
    expect(orderAfterDrag(saved, 'a', 'a')).toBeNull()
  })
})

describe('orderAfterMove', () => {
  it('moves a step one place within the open group, done order untouched', () => {
    expect(orderAfterMove(saved, 'c', 'up')).toEqual(['c', 'a', 'e', 'b', 'd'])
    expect(orderAfterMove(saved, 'c', 'down')).toEqual(['a', 'e', 'c', 'b', 'd'])
  })

  it('cannot move the first open step up or the last open step down', () => {
    expect(orderAfterMove(saved, 'a', 'up')).toBeNull()
    expect(orderAfterMove(saved, 'e', 'down')).toBeNull()
  })

  it('steps over done steps, since they are not in the open group', () => {
    // c sits right after a in the open group even though b (done) is saved between.
    expect(orderAfterMove(saved, 'c', 'up')?.slice(0, 2)).toEqual(['c', 'a'])
  })

  it('does nothing for a done or unknown step', () => {
    expect(orderAfterMove(saved, 'b', 'up')).toBeNull()
    expect(orderAfterMove(saved, 'zzz', 'down')).toBeNull()
  })
})

describe('the hide-completed preference', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('is keyed per checklist under pbj.hideDone.v1', () => {
    expect(hideDoneKey('cl-9')).toBe('pbj.hideDone.v1.cl-9')
  })

  it('is off by default, and remembers on and off per checklist', () => {
    expect(readHideDone('cl-1')).toBe(false)
    writeHideDone('cl-1', true)
    expect(readHideDone('cl-1')).toBe(true)
    expect(readHideDone('cl-2')).toBe(false)
    writeHideDone('cl-1', false)
    expect(readHideDone('cl-1')).toBe(false)
  })
})

// "Done" is the roll-up (the reading the store and the waiting guards use), not
// the raw stored flag: a step stored done with an open sub-step is OPEN.
describe('done is read through the roll-up', () => {
  const staleDone = {
    id: 'b',
    done: true,
    subItems: [{ id: 'b1', done: false }],
  }

  it('sorts a step stored done with an open sub-step into the open group', () => {
    const steps = [{ id: 'a', done: true }, staleDone, { id: 'c', done: false }]
    expect(orderStepsForDisplay(steps).map((step) => step.id)).toEqual(['b', 'c', 'a'])
  })

  it('treats it as open when dragging and moving', () => {
    const steps = [{ id: 'a', done: true }, staleDone, { id: 'c', done: false }]
    expect(orderAfterDrag(steps, 'c', 'b')).toEqual(['c', 'b', 'a'])
    expect(orderAfterMove(steps, 'b', 'down')).toEqual(['c', 'b', 'a'])
  })

  it('reads a sub-step through its own sub-sub-steps', () => {
    const subs = [
      { id: 's1', done: true, subItems: [{ id: 'x', done: false }] },
      { id: 's2', done: true },
    ]
    expect(orderStepsForDisplay(subs).map((step) => step.id)).toEqual(['s1', 's2'])
    expect(isStepDone(subs[0])).toBe(false)
    expect(isStepDone(subs[1])).toBe(true)
  })
})
