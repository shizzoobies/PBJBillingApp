import { describe, expect, it } from 'vitest'
import type { Checklist } from '../lib/types'
import { eligibleChecklistsFor } from '../lib/utils'

function task(partial: Partial<Checklist>): Checklist {
  return {
    id: 'c',
    title: 'Task',
    clientId: 'client-a',
    assigneeId: 'emp-owner',
    items: [],
    ...partial,
  } as Checklist
}

describe('eligibleChecklistsFor', () => {
  it('returns every open task for the client, regardless of who it is assigned to', () => {
    // A staff member assigned to the client must be able to log time against
    // a teammate's task (the get-ahead / shared-board case). If this ever
    // re-adds a per-assignee filter, that flow breaks again.
    const checklists = [
      task({ id: 'mine', assigneeId: 'emp-me' }),
      task({ id: 'teammates', assigneeId: 'emp-other' }),
      task({ id: 'unassigned', assigneeId: '' }),
    ]
    const eligible = eligibleChecklistsFor(checklists, 'client-a').map((c) => c.id)
    expect(eligible).toEqual(['mine', 'teammates', 'unassigned'])
  })

  it('excludes tasks for other clients', () => {
    const checklists = [
      task({ id: 'a', clientId: 'client-a' }),
      task({ id: 'b', clientId: 'client-b' }),
    ]
    expect(eligibleChecklistsFor(checklists, 'client-a').map((c) => c.id)).toEqual(['a'])
  })

  it('hides fully-complete checklists but keeps partial and empty ones', () => {
    const done = (v: boolean) => ({ id: 'i', label: 'x', done: v, subItems: [] })
    const checklists = [
      task({ id: 'empty', items: [] }),
      task({ id: 'partial', items: [done(true), done(false)] as Checklist['items'] }),
      task({ id: 'complete', items: [done(true)] as Checklist['items'] }),
    ]
    expect(eligibleChecklistsFor(checklists, 'client-a').map((c) => c.id)).toEqual([
      'empty',
      'partial',
    ])
  })

  it('returns nothing without a client', () => {
    expect(eligibleChecklistsFor([task({})], '')).toEqual([])
  })
})
