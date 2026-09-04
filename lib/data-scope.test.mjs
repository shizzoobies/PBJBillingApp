/**
 * The TEAM/VISIBILITY split, on the leaf that defines it.
 *
 * `assignedBookkeeperIds` meant two things at once until 2026-09-04: the team
 * an owner picked, and — because every task assignment was written back into
 * it — everyone who had ever been handed work on the client. The Invoice Recap
 * read the second and showed staff invoices for clients they had one checklist
 * on. These tests pin the two halves apart:
 *
 *   - `assignedTeamIds` / `isClientVisibleToUser` stay TEAM (untouched here).
 *   - `taskClientIdsForUser` is the task half, and must reproduce EXACTLY the
 *     three grants `backfillAssignedBookkeepers` (db/store.js) used to write.
 *   - `visibleClientIdsForUser` is their union — a deliberate superset of the
 *     team, which is what gates checklists, time and the dropdowns.
 *
 * docs/plans/team-visibility-split-2026-09.md
 */
import { describe, expect, it } from 'vitest'
import {
  assignedTeamIds,
  isClientVisibleToUser,
  taskClientIdsForUser,
  visibleClientIdsForUser,
} from './data-scope.js'

const LISA = 'emp-lisa'
const DANA = 'emp-dana'

const clients = [
  { id: 'c-team', name: 'Fore Motion', assignedBookkeeperIds: [LISA] },
  { id: 'c-checklist', name: 'Welch Properties', assignedBookkeeperIds: [] },
  { id: 'c-template', name: 'Four Leaf', assignedBookkeeperIds: [] },
  { id: 'c-stage', name: 'Emerald Custom Homes', assignedBookkeeperIds: [] },
  { id: 'c-none', name: 'Skyline', assignedBookkeeperIds: [DANA] },
]

const workspace = (overrides = {}) => ({
  clients,
  checklists: [],
  checklistTemplates: [],
  ...overrides,
})

describe('taskClientIdsForUser', () => {
  it('finds the client of a live checklist assigned to the user', () => {
    const data = workspace({
      checklists: [
        { id: 'chk-1', clientId: 'c-checklist', assigneeId: LISA },
        { id: 'chk-2', clientId: 'c-none', assigneeId: DANA },
      ],
    })
    expect([...taskClientIdsForUser(data, LISA)]).toEqual(['c-checklist'])
  })

  it('finds the client of a recurring TEMPLATE assigned to the user', () => {
    const data = workspace({
      checklistTemplates: [{ id: 'tmpl-1', clientId: 'c-template', assigneeId: LISA }],
    })
    expect([...taskClientIdsForUser(data, LISA)]).toEqual(['c-template'])
  })

  it('finds the client of a template STAGE assigned to the user', () => {
    const data = workspace({
      checklistTemplates: [
        {
          id: 'tmpl-2',
          clientId: 'c-stage',
          assigneeId: DANA,
          stages: [{ id: 'st-1', assigneeId: DANA }, { id: 'st-2', assigneeId: LISA }],
        },
      ],
    })
    expect([...taskClientIdsForUser(data, LISA)]).toEqual(['c-stage'])
  })

  it('counts all three sources at once, de-duplicated', () => {
    const data = workspace({
      checklists: [
        { id: 'chk-1', clientId: 'c-checklist', assigneeId: LISA },
        { id: 'chk-2', clientId: 'c-checklist', assigneeId: LISA },
      ],
      checklistTemplates: [
        { id: 'tmpl-1', clientId: 'c-template', assigneeId: LISA },
        { id: 'tmpl-2', clientId: 'c-stage', stages: [{ id: 'st-1', assigneeId: LISA }] },
      ],
    })
    expect([...taskClientIdsForUser(data, LISA)].sort()).toEqual([
      'c-checklist',
      'c-stage',
      'c-template',
    ])
  })

  // The grant rules mirror `backfillAssignedBookkeepers` exactly, and it never
  // looked at step-level item assignees. A checklist ITEM assigned to someone
  // has never granted anything and must not start now.
  it('ignores step-level item assignees, as the old backfill did', () => {
    const data = workspace({
      checklists: [
        {
          id: 'chk-1',
          clientId: 'c-checklist',
          assigneeId: DANA,
          items: [{ id: 'item-1', label: 'Payroll', assigneeId: LISA }],
        },
      ],
    })
    expect(taskClientIdsForUser(data, LISA).size).toBe(0)
  })

  it('is empty for a falsy user, and for a missing workspace', () => {
    const data = workspace({
      checklists: [{ id: 'chk-1', clientId: 'c-checklist', assigneeId: LISA }],
    })
    expect(taskClientIdsForUser(data, '').size).toBe(0)
    expect(taskClientIdsForUser(data, undefined).size).toBe(0)
    expect(taskClientIdsForUser(null, LISA).size).toBe(0)
    expect(taskClientIdsForUser({}, LISA).size).toBe(0)
  })
})

describe('visibleClientIdsForUser', () => {
  it('team only: no tasks anywhere, and the team list still decides', () => {
    expect([...visibleClientIdsForUser(workspace(), LISA)]).toEqual(['c-team'])
    expect([...visibleClientIdsForUser(workspace(), DANA)]).toEqual(['c-none'])
  })

  it('task only: a checklist grants the client without touching the team', () => {
    const data = workspace({
      clients: clients.map((c) => ({ ...c, assignedBookkeeperIds: [] })),
      checklists: [{ id: 'chk-1', clientId: 'c-checklist', assigneeId: LISA }],
    })
    expect([...visibleClientIdsForUser(data, LISA)]).toEqual(['c-checklist'])
    // The team itself is untouched — this is the whole point of the split.
    expect(assignedTeamIds(data.clients[1])).toEqual([])
    expect(isClientVisibleToUser(data.clients[1], LISA)).toBe(false)
  })

  it('task only: a template and a template stage do the same', () => {
    const data = workspace({
      clients: clients.map((c) => ({ ...c, assignedBookkeeperIds: [] })),
      checklistTemplates: [
        { id: 'tmpl-1', clientId: 'c-template', assigneeId: LISA },
        { id: 'tmpl-2', clientId: 'c-stage', stages: [{ id: 'st-1', assigneeId: LISA }] },
      ],
    })
    expect([...visibleClientIdsForUser(data, LISA)].sort()).toEqual(['c-stage', 'c-template'])
  })

  it('unions the team with the tasks, without double-counting an overlap', () => {
    const data = workspace({
      checklists: [
        { id: 'chk-1', clientId: 'c-checklist', assigneeId: LISA },
        // Already on this client's team; the union must not list it twice.
        { id: 'chk-2', clientId: 'c-team', assigneeId: LISA },
      ],
      checklistTemplates: [{ id: 'tmpl-1', clientId: 'c-template', assigneeId: LISA }],
    })
    expect([...visibleClientIdsForUser(data, LISA)].sort()).toEqual([
      'c-checklist',
      'c-team',
      'c-template',
    ])
  })

  it('is empty for a falsy user id', () => {
    const data = workspace({
      checklists: [{ id: 'chk-1', clientId: 'c-checklist', assigneeId: '' }],
    })
    expect(visibleClientIdsForUser(data, '').size).toBe(0)
    expect(visibleClientIdsForUser(data, null).size).toBe(0)
  })

  // No role branch in the leaf: an owner who has been picked onto a team is
  // just a member here, and an owner with no team membership gets nothing.
  // Owners never reach this function — `visibleClientIdSet` (server.js) hands
  // them every client id before it is called — and a role filter here would be
  // dead code pretending to be a rule.
  it('treats an owner on a team as an ordinary member, with no special case', () => {
    const OWNER = 'owner-brittany'
    const data = workspace({
      clients: [
        { id: 'c-team', assignedBookkeeperIds: [OWNER] },
        { id: 'c-other', assignedBookkeeperIds: [] },
      ],
      checklists: [{ id: 'chk-1', clientId: 'c-other', assigneeId: OWNER }],
    })
    expect([...visibleClientIdsForUser(data, OWNER)].sort()).toEqual(['c-other', 'c-team'])
  })
})
