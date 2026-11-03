import { describe, expect, it } from 'vitest'
import { sortMostRecentlyCompletedFirst } from './completedTasks'
import type { Checklist } from './types'

/**
 * featreq-6c7ff53b: completed checklists list the most recently completed
 * first. Completion = the latest step stamp; a checklist finished before the
 * app recorded stamps goes last, and ties keep the order they came in.
 */

const done = (id: string, ...stamps: Array<string | undefined>): Checklist =>
  ({
    id,
    title: id,
    clientId: 'client-a',
    items: stamps.map((completedAt, index) => ({
      id: `${id}-${index}`,
      label: 'Step',
      done: true,
      ...(completedAt ? { completedAt } : {}),
    })),
  }) as unknown as Checklist

const ids = (list: Checklist[]) => list.map((checklist) => checklist.id)

describe('sortMostRecentlyCompletedFirst', () => {
  it('puts the newest completion first, then older ones', () => {
    const older = done('older', '2026-10-01T10:00:00.000Z')
    const middle = done('middle', '2026-10-10T10:00:00.000Z')
    const newest = done('newest', '2026-10-20T10:00:00.000Z')
    expect(ids(sortMostRecentlyCompletedFirst([older, middle, newest]))).toEqual([
      'newest',
      'middle',
      'older',
    ])
  })

  it('a newly completed checklist (latest stamp) goes to the top', () => {
    const list = [done('a', '2026-10-01T10:00:00.000Z'), done('b', '2026-10-02T10:00:00.000Z')]
    const justNow = done('just-now', '2026-10-01T09:00:00.000Z', '2026-11-03T15:00:00.000Z')
    expect(ids(sortMostRecentlyCompletedFirst([...list, justNow]))[0]).toBe('just-now')
  })

  it('puts undated checklists last, in the order they arrived', () => {
    const undatedFirst = done('undated-1', undefined)
    const dated = done('dated', '2026-10-05T10:00:00.000Z')
    const undatedSecond = done('undated-2', undefined)
    expect(ids(sortMostRecentlyCompletedFirst([undatedFirst, dated, undatedSecond]))).toEqual([
      'dated',
      'undated-1',
      'undated-2',
    ])
  })

  it('keeps the incoming order for equal stamps and does not change its input', () => {
    const input = [done('x', '2026-10-05T10:00:00.000Z'), done('y', '2026-10-05T10:00:00.000Z')]
    expect(ids(sortMostRecentlyCompletedFirst(input))).toEqual(['x', 'y'])
    const reversed = [input[1], input[0]]
    expect(ids(sortMostRecentlyCompletedFirst(reversed))).toEqual(['y', 'x'])
    expect(ids(input)).toEqual(['x', 'y'])
  })
})
