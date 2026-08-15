import { describe, expect, it } from 'vitest'
import { checklistsVisibleTo } from '../lib/checklistVisibility'
import { openTaskAssigneeScope, scopeChecklistsToOpenTaskOwners } from '../lib/openTaskScope'
import type { Checklist, Client } from '../lib/types'

/**
 * "An employee should not be able to edit another employee's checklist they are
 * not active on (basically in brittanybookkeeping I could click the checklist
 * button that she is a client on and make changes to Lisa's active checklist)."
 *   — the firm owner, featreq-9b47ab5b
 *
 * The server refuses those writes (lib/checklist-write-permission.js). These
 * are the client-side halves: which tasks a surface is allowed to PUT IN FRONT
 * of someone, which is what made the mistake possible in the first place.
 */

const BRITTANY = 'emp-brit' // the bookkeeper who reproduced it
const LISA = 'emp-lisa' // her colleague on the shared client
const OWNER = 'emp-patrice'

const checklist = (over: Partial<Checklist> = {}): Checklist =>
  ({
    id: 'cl-1',
    clientId: 'client-shared',
    title: 'Monthly close',
    assigneeId: LISA,
    dueDate: '2026-08-31',
    items: [],
    ...over,
  }) as Checklist

const lisas = checklist({ id: 'cl-lisa', assigneeId: LISA })
const britts = checklist({ id: 'cl-brit', assigneeId: BRITTANY })

describe('checklistsVisibleTo — the "mine" narrowing', () => {
  it('hides a colleague’s task on a client they share', () => {
    const mine = checklistsVisibleTo([lisas, britts], {
      viewerId: BRITTANY,
      isOwner: false,
    })
    expect(mine.map((entry) => entry.id)).toEqual(['cl-brit'])
  })

  it('leaves the owner everything', () => {
    const all = checklistsVisibleTo([lisas, britts], { viewerId: OWNER, isOwner: true })
    expect(all).toHaveLength(2)
  })

  it('honors an explicit viewer share — the owner naming you is a decision', () => {
    const shared = checklist({ id: 'cl-shared', assigneeId: LISA, viewerIds: [BRITTANY] })
    const mine = checklistsVisibleTo([shared], { viewerId: BRITTANY, isOwner: false })
    expect(mine.map((entry) => entry.id)).toEqual(['cl-shared'])
  })

  it('leaves an unassigned task out of a staff member’s list', () => {
    const orphan = checklist({ id: 'cl-orphan', assigneeId: '' })
    expect(checklistsVisibleTo([orphan], { viewerId: BRITTANY, isOwner: false })).toEqual([])
  })
})

/**
 * The open-task badge. There is NO accountant→bookkeeper supervision
 * relationship stored anywhere in this app — `clients.assigned_bookkeeper_ids`
 * is the only user-to-user link — so "the bookkeepers whose clients they
 * oversee" is read as shared client assignment. Pinned here so the substitution
 * is visible rather than folklore.
 */
const client = (id: string, team: string[]): Client =>
  ({ id, name: id, assignedBookkeeperIds: team }) as Client

describe('openTaskAssigneeScope', () => {
  const clients = [
    client('client-shared', [BRITTANY, LISA]),
    client('client-elsewhere', ['emp-dana']),
  ]

  it('gives an owner no restriction at all', () => {
    expect(
      openTaskAssigneeScope({ viewerId: OWNER, isOwner: true, staffRole: 'Owner', clients }),
    ).toBeNull()
  })

  it('limits a bookkeeper to themselves', () => {
    const scope = openTaskAssigneeScope({
      viewerId: BRITTANY,
      isOwner: false,
      staffRole: 'Bookkeeper',
      clients,
    })
    expect([...(scope ?? [])]).toEqual([BRITTANY])
  })

  it('widens an accountant to the people staffed alongside them', () => {
    const scope = openTaskAssigneeScope({
      viewerId: BRITTANY,
      isOwner: false,
      staffRole: 'Accountant',
      clients,
    })
    expect(scope?.has(BRITTANY)).toBe(true)
    expect(scope?.has(LISA)).toBe(true)
    // Nobody from a client they are not on.
    expect(scope?.has('emp-dana')).toBe(false)
  })
})

describe('scopeChecklistsToOpenTaskOwners', () => {
  it('counts only the viewer’s tasks for a bookkeeper', () => {
    const scope = new Set([BRITTANY])
    expect(scopeChecklistsToOpenTaskOwners([lisas, britts], scope).map((e) => e.id)).toEqual([
      'cl-brit',
    ])
  })

  it('drops unassigned tasks for a scoped viewer but keeps them for an owner', () => {
    const orphan = checklist({ id: 'cl-orphan', assigneeId: '' })
    expect(scopeChecklistsToOpenTaskOwners([orphan], new Set([BRITTANY]))).toEqual([])
    expect(scopeChecklistsToOpenTaskOwners([orphan], null)).toHaveLength(1)
  })
})
