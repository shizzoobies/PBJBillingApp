import { describe, expect, it } from 'vitest'
import {
  boardChecklistsFor,
  boardTeamMemberIds,
  checklistsVisibleTo,
} from '../lib/checklistVisibility'
import { openTaskAssigneeScope, scopeChecklistsToOpenTaskOwners } from '../lib/openTaskScope'
import type { Checklist, ChecklistTemplate, Employee } from '../lib/types'

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
const DANA = 'emp-dana' // someone on a client the viewer cannot see at all
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
 * The open-task badge.
 *
 * REWRITTEN FOR featreq-4fa0e70f. These used to pin the old substitution:
 * "the bookkeepers whose clients they oversee" was read off
 * `clients.assigned_bookkeeper_ids`, the only user-to-user link the schema had.
 * The 2026-09-04 team/visibility split turned that field into the MONEY gate —
 * the hand-picked team that alone opens a client's invoices — and left task
 * visibility computed from the work itself. An accountant who reaches her
 * clients by task assignment is on nobody's explicit team, so the old rule
 * handed her only herself and hid her bookkeepers. The rule now reads the feed
 * the server already scoped to her clients, and that is what these pin.
 */
const employee = (id: string, role: Employee['role']): Employee =>
  ({ id, name: id, role }) as Employee

/** Nobody here is on anybody's explicit team — that is the whole point. */
const ROSTER = [
  employee(BRITTANY, 'Accountant'),
  employee(LISA, 'Bookkeeper'),
  employee(DANA, 'Bookkeeper'),
  employee(OWNER, 'Owner'),
]

const template = (over: Record<string, unknown> = {}): ChecklistTemplate =>
  ({
    id: 'tpl-1',
    clientId: 'client-shared',
    title: 'Monthly close',
    assigneeId: '',
    stages: [],
    ...over,
  }) as unknown as ChecklistTemplate

describe('openTaskAssigneeScope', () => {
  // The session's own feed: every task on a client the viewer can see. Dana's
  // client is not in it, because the server never sent it.
  const feed = [lisas, britts]

  it('gives an owner no restriction at all', () => {
    expect(
      openTaskAssigneeScope({
        viewerId: OWNER,
        isOwner: true,
        staffRole: 'Owner',
        checklists: feed,
      }),
    ).toBeNull()
  })

  it('limits a bookkeeper to themselves, handed the whole shared feed', () => {
    const scope = openTaskAssigneeScope({
      viewerId: BRITTANY,
      isOwner: false,
      staffRole: 'Bookkeeper',
      checklists: feed,
    })
    expect([...(scope ?? [])]).toEqual([BRITTANY])
  })

  it('widens an accountant to everyone holding live work in her feed', () => {
    const scope = openTaskAssigneeScope({
      viewerId: BRITTANY,
      isOwner: false,
      staffRole: 'Accountant',
      checklists: feed,
    })
    expect(scope?.has(BRITTANY)).toBe(true)
    // Lisa shares no explicit team with her; the old rule missed her entirely.
    expect(scope?.has(LISA)).toBe(true)
    // Dana holds nothing here, so she is on a client this viewer cannot see.
    expect(scope?.has(DANA)).toBe(false)
  })

  it('leaves the firm owner out — she works clients too, but she is not a bookkeeper', () => {
    const owners = checklist({ id: 'cl-owner', assigneeId: OWNER })
    const scope = openTaskAssigneeScope({
      viewerId: BRITTANY,
      isOwner: false,
      staffRole: 'Accountant',
      checklists: [...feed, owners],
      employees: ROSTER,
    })
    expect(scope?.has(OWNER)).toBe(false)
    expect(scope?.has(LISA)).toBe(true)
  })

  it('counts recurring template and stage assignees, mirroring taskClientIdsForUser', () => {
    const scope = openTaskAssigneeScope({
      viewerId: BRITTANY,
      isOwner: false,
      staffRole: 'Accountant',
      checklists: [],
      checklistTemplates: [
        template({ id: 'tpl-recurring', assigneeId: LISA }),
        template({ id: 'tpl-staged', stages: [{ assigneeId: DANA }] }),
      ],
    })
    expect(scope?.has(LISA)).toBe(true)
    expect(scope?.has(DANA)).toBe(true)
  })
})

/**
 * The Board, reworked after the owner reviewed it signed in as Lisa:
 *
 * "The standard view should be checklist they are active on only — a bookkeeper
 * should only see hers and an accountant should see hers, and could we add a
 * button like show upcoming that she could see those 'under' her aka the
 * bookkeepers?"   — featreq-9b47ab5b, reopened
 */
describe('the Board — whose work it shows', () => {
  // The feed exactly as the server sends it to this accountant: her own task
  // and Lisa's, on clients she reaches through task visibility rather than
  // through an owner-picked team. Dana's client is withheld upstream.
  const feed = [lisas, britts]
  const danas = checklist({ id: 'cl-dana', clientId: 'client-elsewhere', assigneeId: DANA })

  it('shows a bookkeeper only the checklists she is active on', () => {
    const board = boardChecklistsFor(feed, {
      viewerId: LISA,
      isOwner: false,
      staffRole: 'Bookkeeper',
    })
    expect(board.map((entry) => entry.id)).toEqual(['cl-lisa'])
  })

  it('shows an accountant only her own by default', () => {
    const board = boardChecklistsFor(feed, {
      viewerId: BRITTANY,
      isOwner: false,
      staffRole: 'Accountant',
    })
    expect(board.map((entry) => entry.id)).toEqual(['cl-brit'])
  })

  /**
   * THE REGRESSION — featreq-4fa0e70f, Allison and Lisa.
   *
   * This accountant is on NOBODY's explicit team; every client in her feed is
   * one she reaches because she holds a task on it. FAILS ON THE OLD CODE: the
   * team-based rule returned {herself}, so Lisa was never in scope and the
   * board came back with her own card alone.
   */
  it('reveals a bookkeeper’s work on a client the accountant reaches by task, not by team', () => {
    const scope = openTaskAssigneeScope({
      viewerId: BRITTANY,
      isOwner: false,
      staffRole: 'Accountant',
      checklists: feed,
    })
    expect(scope?.has(LISA)).toBe(true)

    const board = boardChecklistsFor(feed, {
      viewerId: BRITTANY,
      isOwner: false,
      staffRole: 'Accountant',
      employees: ROSTER,
      includeTeam: true,
    })
    expect(board.map((entry) => entry.id).sort()).toEqual(['cl-brit', 'cl-lisa'])
  })

  /**
   * The other half of "my BOOKKEEPERS" (featreq-4fa0e70f): Brittany Ferguson
   * works clients herself — four of Allison's carry open checklists of hers —
   * and reading assignees off the feed would otherwise hand them to Allison as
   * work under her. The toggle must not surface an owner's task at all, tagged
   * or untagged; a bookkeeper's on the very same client still comes through.
   */
  it('never reveals the owner’s own task, while a bookkeeper’s on that client still shows', () => {
    const owners = checklist({ id: 'cl-owner', assigneeId: OWNER })
    const board = boardChecklistsFor([...feed, owners], {
      viewerId: BRITTANY,
      isOwner: false,
      staffRole: 'Accountant',
      employees: ROSTER,
      includeTeam: true,
    })
    expect(board.some((entry) => entry.id === 'cl-owner')).toBe(false)
    expect(board.map((entry) => entry.id).sort()).toEqual(['cl-brit', 'cl-lisa'])
  })

  // REWRITTEN FOR featreq-4fa0e70f: this used to prove the exclusion with an
  // explicit team ("Dana is on a client this accountant is not staffed on").
  // The boundary is now the feed — the server never sends Dana's client, so her
  // card cannot appear no matter how wide the scope gets.
  it('folds in her bookkeepers’ work when the toggle is on — and nobody else’s', () => {
    const board = boardChecklistsFor(feed, {
      viewerId: BRITTANY,
      isOwner: false,
      staffRole: 'Accountant',
      employees: ROSTER,
      includeTeam: true,
    })
    expect(board.map((entry) => entry.id).sort()).toEqual(['cl-brit', 'cl-lisa'])
    expect(board.some((entry) => entry.id === 'cl-dana')).toBe(false)
  })

  it('never returns a checklist its input did not contain, toggle and all', () => {
    const board = boardChecklistsFor(feed, {
      viewerId: BRITTANY,
      isOwner: false,
      staffRole: 'Accountant',
      employees: ROSTER,
      includeTeam: true,
    })
    const given = new Set(feed.map((entry) => entry.id))
    expect(board.every((entry) => given.has(entry.id))).toBe(true)
    // The one the server withheld stays withheld: widening who counts as "her
    // bookkeepers" cannot widen what reached the browser.
    expect(board.some((entry) => entry.id === danas.id)).toBe(false)
  })

  it('leaves a bookkeeper’s board alone even if the toggle is somehow on', () => {
    const board = boardChecklistsFor(feed, {
      viewerId: LISA,
      isOwner: false,
      staffRole: 'Bookkeeper',
      includeTeam: true,
    })
    expect(board.map((entry) => entry.id)).toEqual(['cl-lisa'])
  })

  it('leaves the owner’s board untouched — Brittany reviews everyone', () => {
    const board = boardChecklistsFor([...feed, danas], {
      viewerId: OWNER,
      isOwner: true,
      staffRole: 'Owner',
      includeTeam: false,
    })
    expect(board).toEqual([...feed, danas])
  })

  it('never duplicates a task the accountant is already active on', () => {
    const shared = checklist({ id: 'cl-shared', assigneeId: LISA, viewerIds: [BRITTANY] })
    const board = boardChecklistsFor([shared], {
      viewerId: BRITTANY,
      isOwner: false,
      staffRole: 'Accountant',
      employees: ROSTER,
      includeTeam: true,
    })
    expect(board.map((entry) => entry.id)).toEqual(['cl-shared'])
  })

  describe('boardTeamMemberIds — who the toggle is offered for', () => {
    // REWRITTEN FOR featreq-4fa0e70f: "the people staffed alongside her" was the
    // explicit team; it is now the people doing live work on her clients.
    it('gives an accountant the people doing live work on her clients, minus herself', () => {
      expect(
        boardTeamMemberIds({
          viewerId: BRITTANY,
          isOwner: false,
          staffRole: 'Accountant',
          checklists: feed,
          employees: ROSTER,
        }),
      ).toEqual([LISA])
    })

    it('never offers the owner — the toggle says “my bookkeepers”', () => {
      const owners = checklist({ id: 'cl-owner', assigneeId: OWNER })
      expect(
        boardTeamMemberIds({
          viewerId: BRITTANY,
          isOwner: false,
          staffRole: 'Accountant',
          checklists: [...feed, owners],
          employees: ROSTER,
        }),
      ).toEqual([LISA])
    })

    it('gives a bookkeeper nobody, so the toggle never renders for her', () => {
      expect(
        boardTeamMemberIds({
          viewerId: LISA,
          isOwner: false,
          staffRole: 'Bookkeeper',
          checklists: feed,
          employees: ROSTER,
        }),
      ).toEqual([])
    })

    it('gives an owner nobody — her board is already everyone’s', () => {
      expect(
        boardTeamMemberIds({
          viewerId: OWNER,
          isOwner: true,
          staffRole: 'Owner',
          checklists: feed,
          employees: ROSTER,
        }),
      ).toEqual([])
    })

    // REWRITTEN FOR featreq-4fa0e70f: "alone on all her clients" used to mean an
    // explicit team of one. It now means a feed holding only her own work.
    it('gives an accountant whose feed holds only her own work nobody', () => {
      expect(
        boardTeamMemberIds({
          viewerId: BRITTANY,
          isOwner: false,
          staffRole: 'Accountant',
          checklists: [britts],
          employees: ROSTER,
        }),
      ).toEqual([])
    })
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
