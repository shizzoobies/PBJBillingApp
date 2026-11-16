import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  approvalAfterEdit,
  editRequiresReapproval,
  isOwnersOwnTime,
} from '../../lib/time-entry.js'

/**
 * An owner does not approve her own things (featreq-5ad33ce9).
 *
 * Brittany: "Can we make it to where I do not need to approve my stuff - ie,
 * forgot to enter time - checklist deletion". A read-only look at production
 * found she had approved her OWN time entries 268 times in 120 days: a manual
 * entry, the shares of a block she split and any entry she edited all queued
 * as pending, and the only person who could approve them was her. Her own
 * skips and pushes of a repeating task landed in her own "to review" list the
 * same way. (A checklist or a step she deletes herself was already deleted at
 * once; only a team member's becomes a request.)
 *
 * The rule lives in lib/time-entry.js so both the routes and these tests read
 * one copy. The store half (what is written) is in db/store-staleness.test.mjs.
 */

const OWNER = { id: 'emp-owner', role: 'owner' }
const OTHER_OWNER = { id: 'emp-owner-2', role: 'owner' }
const STAFF = { id: 'emp-staff', role: 'bookkeeper' }

describe('isOwnersOwnTime', () => {
  it('is true only for an owner and her own id', () => {
    expect(isOwnersOwnTime(OWNER, 'emp-owner')).toBe(true)
  })

  it('is false for an owner looking at anyone else, the other owner included', () => {
    expect(isOwnersOwnTime(OWNER, 'emp-staff')).toBe(false)
    expect(isOwnersOwnTime(OWNER, 'emp-owner-2')).toBe(false)
    expect(isOwnersOwnTime(OTHER_OWNER, 'emp-owner')).toBe(false)
  })

  it('is false for a team member on their own time: someone else approves it', () => {
    expect(isOwnersOwnTime(STAFF, 'emp-staff')).toBe(false)
    expect(isOwnersOwnTime({ id: 'emp-senior', role: 'senior_bookkeeper' }, 'emp-senior')).toBe(false)
  })

  it('is false when anything is missing, never true by accident', () => {
    expect(isOwnersOwnTime(null, 'emp-owner')).toBe(false)
    expect(isOwnersOwnTime(undefined, undefined)).toBe(false)
    expect(isOwnersOwnTime({ role: 'owner' }, undefined)).toBe(false)
    expect(isOwnersOwnTime({ role: 'owner', id: '' }, '')).toBe(false)
    expect(isOwnersOwnTime(OWNER, '')).toBe(false)
    expect(isOwnersOwnTime(OWNER, null)).toBe(false)
  })
})

describe('approvalAfterEdit: an owner editing her own entry', () => {
  const own = (approvalStatus: string, patch: Record<string, unknown>) =>
    approvalAfterEdit({ approvalStatus, patch, user: OWNER, employeeId: 'emp-owner' })

  it('never sends her own approved entry back to her own queue', () => {
    expect(own('approved', { minutes: 90 })).not.toBe('requeue')
    expect(own('approved', { clientId: 'c2', date: '2026-11-03', description: 'x' })).not.toBe('requeue')
    // The old rule did: this is the change.
    expect(editRequiresReapproval('approved', { minutes: 90 }, true)).toBe(true)
  })

  // Stamped again, by her, now: the record must not go on naming whoever
  // approved the hours as they were (the other owner, a weekly seal) for hours
  // that person never saw.
  it('stamps her own approved entry as approved by her when she changes it', () => {
    expect(own('approved', { minutes: 300 })).toBe('approve')
    expect(own('approved', { isAdhoc: true })).toBe('approve')
    expect(own('approved', { billable: false })).toBe('approve')
  })

  it('approves one of hers that was still waiting when she edits it', () => {
    expect(own('pending', { minutes: 90 })).toBe('approve')
    expect(own('pending', { isAdhoc: true })).toBe('approve')
  })

  it('treats a status it does not know like anyone else’s entry, never as approved', () => {
    expect(own('', { minutes: 90 })).toBe('keep')
    expect(own('draft', { minutes: 90 })).toBe('keep')
  })

  // Only the OTHER owner can have sent her entry back. Her edit must not
  // quietly overrule that: it goes back to the queue both owners see, exactly
  // as it did before this change.
  it('does not approve one of hers that was sent back: it returns to the queue', () => {
    expect(own('rejected', { description: 'fixed' })).toBe('requeue')
    expect(own('rejected', { minutes: 30, employeeId: 'emp-owner' })).toBe('requeue')
    for (const patch of [{ description: 'fixed' }, { isAdhoc: true }, { billable: false }, {}]) {
      expect(own('rejected', patch)).toBe(
        editRequiresReapproval('rejected', patch, true) ? 'requeue' : 'keep',
      )
    }
  })

  it('does nothing for a save that changes nothing', () => {
    expect(own('pending', {})).toBe('keep')
    expect(own('approved', {})).toBe('keep')
    expect(own('rejected', {})).toBe('keep')
  })

  it('an edit that keeps the entry hers by naming her again is still her own', () => {
    expect(own('pending', { employeeId: 'emp-owner', minutes: 30 })).toBe('approve')
    expect(own('approved', { employeeId: 'emp-owner', minutes: 30 })).toBe('approve')
  })

  it('moving her entry to someone else is not "her own time": the ordinary rule applies', () => {
    expect(own('approved', { employeeId: 'emp-staff' })).toBe('requeue')
    expect(own('rejected', { employeeId: 'emp-staff', minutes: 30 })).toBe('requeue')
    // A pending one stays pending for that person's review; it is not approved.
    expect(own('pending', { employeeId: 'emp-staff' })).toBe('keep')
  })
})

describe('approvalAfterEdit: everyone else is exactly the old rule', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['approved', { minutes: 90 }],
    ['approved', {}],
    ['approved', { isAdhoc: true }],
    ['approved', { billable: false }],
    ['approved', { isAdhoc: true, minutes: 45 }],
    ['rejected', { clientId: 'c2' }],
    ['pending', { minutes: 90 }],
    ['pending', {}],
  ]

  it('an owner editing a team member’s entry', () => {
    for (const [approvalStatus, patch] of cases) {
      const expected = editRequiresReapproval(approvalStatus, patch, true) ? 'requeue' : 'keep'
      expect(
        approvalAfterEdit({ approvalStatus, patch, user: OWNER, employeeId: 'emp-staff' }),
      ).toBe(expected)
    }
  })

  it('an owner editing the OTHER owner’s entry', () => {
    for (const [approvalStatus, patch] of cases) {
      const expected = editRequiresReapproval(approvalStatus, patch, true) ? 'requeue' : 'keep'
      expect(
        approvalAfterEdit({ approvalStatus, patch, user: OWNER, employeeId: 'emp-owner-2' }),
      ).toBe(expected)
    }
  })

  it('a team member editing their own entry', () => {
    for (const [approvalStatus, patch] of cases) {
      const expected = editRequiresReapproval(approvalStatus, patch, false) ? 'requeue' : 'keep'
      expect(
        approvalAfterEdit({ approvalStatus, patch, user: STAFF, employeeId: 'emp-staff' }),
      ).toBe(expected)
    }
  })

  it('an owner taking over someone else’s entry does not approve it by that edit', () => {
    expect(
      approvalAfterEdit({
        approvalStatus: 'pending',
        patch: { employeeId: 'emp-owner' },
        user: OWNER,
        employeeId: 'emp-staff',
      }),
    ).toBe('keep')
    expect(
      approvalAfterEdit({
        approvalStatus: 'approved',
        patch: { employeeId: 'emp-owner' },
        user: OWNER,
        employeeId: 'emp-staff',
      }),
    ).toBe('requeue')
  })

  it('never answers "approve" for anyone but an owner on her own entry', () => {
    for (const user of [STAFF, OTHER_OWNER, null, undefined, { role: 'owner' }]) {
      for (const [approvalStatus, patch] of cases) {
        expect(
          approvalAfterEdit({ approvalStatus, patch, user, employeeId: 'emp-owner' }),
        ).not.toBe('approve')
      }
    }
  })
})

/**
 * The routes are not booted by the tests, so their glue is pinned by reading
 * the source (the same way time-entry-required-fields.test.ts does).
 */
describe('the routes use the one rule (read from server.js)', () => {
  const server = readFileSync(resolve('server.js'), 'utf8').split('\r\n').join('\n')

  it('POST /api/time-entries hands the store the word only for her own time', () => {
    expect(server).toContain('const ownTime = isOwnersOwnTime(session.user, employeeId)')
    expect(server).toContain('selfApproved: ownTime,')
  })

  it('nobody is told her own manual entry "needs approval"', () => {
    const start = server.indexOf("if (entryMethod === 'manual' && ownTime) {")
    const otherwise = server.indexOf("} else if (entryMethod === 'manual') {", start)
    expect(start).toBeGreaterThan(0)
    expect(otherwise).toBeGreaterThan(start)
    const ownBranch = server.slice(start, otherwise)
    expect(ownBranch).toContain("'time_entry_manual_submitted'")
    expect(ownBranch).not.toContain('notify(')
    // Everyone else's manual entry still pings the owners.
    const rest = server.slice(otherwise, server.indexOf('[notify] time_entry_manual dispatch failed', otherwise))
    expect(rest).toContain("'time_entry_manual'")
    expect(rest).toContain('needs approval')
  })

  it('the edit route decides the sign-off through approvalAfterEdit, with the entry’s owner before the edit', () => {
    const patchStart = server.indexOf('// ---- Edit (PATCH) ----')
    const patchEnd = server.indexOf("request.method === 'DELETE'", patchStart)
    expect(patchStart).toBeGreaterThan(0)
    expect(patchEnd).toBeGreaterThan(patchStart)
    const patchRoute = server.slice(patchStart, patchEnd)
    expect(patchRoute).toContain('const signOff = approvalAfterEdit({')
    expect(patchRoute).toContain('employeeId: entry.employeeId,')
    expect(patchRoute).toContain("if (signOff === 'requeue') {")
    expect(patchRoute).toContain("} else if (signOff === 'approve') {")
    expect(patchRoute).toContain('patch.approvedBy = session.user.id')
    // The old direct call is gone from the route: one rule, one place.
    expect(patchRoute).not.toContain('editRequiresReapproval(')
  })

  it('the split route passes whose block it is, and never for one that was sent back', () => {
    const start = server.indexOf('await appDataStore.splitTimeEntry(')
    const call = server.slice(start, server.indexOf('sendJson(response, 200, result)', start))
    expect(start).toBeGreaterThan(0)
    expect(call).toContain('isOwnersOwnTime(session.user, holding.employeeId) &&')
    expect(call).toContain("holding.approvalStatus !== 'rejected'")
  })

  it('the adjust route requires EVERY share to be hers, and none sent back', () => {
    const start = server.indexOf('await appDataStore.adjustSplitGroup(')
    const call = server.slice(start, server.indexOf('sendJson(response, 200, result)', start))
    expect(start).toBeGreaterThan(0)
    expect(call).toContain('selfApproved: slices.every(')
    expect(call).toContain('isOwnersOwnTime(session.user, slice.employeeId) &&')
    expect(call).toContain("slice.approvalStatus !== 'rejected'")
  })

  it('an owner’s own skip and her own push are stamped reviewed as they are filed', () => {
    const helperStart = server.indexOf('async function reviewOwnSkipIfOwner(session, record) {')
    const helperEnd = server.indexOf('async function fileItemDeletionRequest(')
    expect(helperStart).toBeGreaterThan(0)
    expect(helperEnd).toBeGreaterThan(helperStart)
    const helper = server.slice(helperStart, helperEnd)
    expect(helper).toContain("if (session?.user?.role !== 'owner' || !record?.id) return")
    expect(helper).toContain('await appDataStore.reviewChecklistSkip(record.id, session.user.id)')
    expect(server).toContain('await reviewOwnSkipIfOwner(session, record)')
    expect(server).toContain('await reviewOwnSkipIfOwner(session, pushRecord)')
    // Exactly the two places a skip record is filed.
    expect(server.split('appDataStore.createChecklistSkip(').length - 1).toBe(2)
    expect(server.split('await reviewOwnSkipIfOwner(').length - 1).toBe(2)
  })
})
