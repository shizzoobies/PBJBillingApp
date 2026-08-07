import { describe, expect, it } from 'vitest'

import {
  templateApplyRoleDenial,
  templateApplyScopeDenial,
} from './template-apply-permission.js'

/**
 * Permission matrix for applying a checklist template to a client.
 *
 * These mirror an end-to-end run against a local server on the file backend
 * (owner / accountant / bookkeeper sessions, standard vs client-bound
 * templates, assigned vs unassigned targets). That run is what caught the
 * `role` vs `staffRole` bug in the first place — code review did not. The
 * cases below pin the same decisions cheaply enough to run on every commit.
 */

// A session user as `mapSessionUser()` actually produces one: `role` is only
// ever 'owner' | 'employee', with the staff role carried separately.
const OWNER = { role: 'owner', staffRole: 'Owner' }
const ACCOUNTANT = { role: 'employee', staffRole: 'Accountant' }
const BOOKKEEPER = { role: 'employee', staffRole: 'Bookkeeper' }

const STANDARD = { isStandard: true }
const CLIENT_BOUND = { isStandard: false }

const ASSIGNED = 'client-clover'
const UNASSIGNED = 'client-riverbend'
const visible = new Set([ASSIGNED])

describe('templateApplyRoleDenial', () => {
  it('lets owners through', () => {
    expect(templateApplyRoleDenial(OWNER)).toBeNull()
  })

  // The regression. `senior_bookkeeper` is the DATABASE role; a session only
  // ever carries role 'employee' plus staffRole 'Accountant'. Comparing the
  // session role against the database role refused every accountant.
  it('lets accountants through on staffRole, not the database role', () => {
    expect(templateApplyRoleDenial(ACCOUNTANT)).toBeNull()
    expect(ACCOUNTANT.role).not.toBe('senior_bookkeeper')
  })

  it('refuses bookkeepers', () => {
    expect(templateApplyRoleDenial(BOOKKEEPER)).toMatchObject({ status: 403 })
  })

  it('refuses a user with no staff role at all', () => {
    expect(templateApplyRoleDenial({ role: 'employee' })).toMatchObject({ status: 403 })
    expect(templateApplyRoleDenial(undefined)).toMatchObject({ status: 403 })
  })
})

describe('templateApplyScopeDenial', () => {
  it('exempts owners from both restrictions', () => {
    expect(
      templateApplyScopeDenial({
        user: OWNER,
        template: CLIENT_BOUND,
        clientId: UNASSIGNED,
        visibleClientIds: new Set(),
      }),
    ).toBeNull()
  })

  it('lets an accountant apply a standard blueprint to an assigned client', () => {
    expect(
      templateApplyScopeDenial({
        user: ACCOUNTANT,
        template: STANDARD,
        clientId: ASSIGNED,
        visibleClientIds: visible,
      }),
    ).toBeNull()
  })

  it('refuses an accountant a client they are not assigned to', () => {
    expect(
      templateApplyScopeDenial({
        user: ACCOUNTANT,
        template: STANDARD,
        clientId: UNASSIGNED,
        visibleClientIds: visible,
      }),
    ).toMatchObject({ status: 403 })
  })

  it('refuses an accountant a client-bound template', () => {
    expect(
      templateApplyScopeDenial({
        user: ACCOUNTANT,
        template: CLIENT_BOUND,
        clientId: ASSIGNED,
        visibleClientIds: visible,
      }),
    ).toMatchObject({ status: 403 })
  })

  // `isStandard` absent must not read as "standard" — a template predating the
  // flag would otherwise become copyable by any accountant.
  it('treats a missing isStandard as not standard', () => {
    expect(
      templateApplyScopeDenial({
        user: ACCOUNTANT,
        template: {},
        clientId: ASSIGNED,
        visibleClientIds: visible,
      }),
    ).toMatchObject({ status: 403 })
  })

  it('refuses when the visible-client set is missing entirely', () => {
    expect(
      templateApplyScopeDenial({
        user: ACCOUNTANT,
        template: STANDARD,
        clientId: ASSIGNED,
        visibleClientIds: undefined,
      }),
    ).toMatchObject({ status: 403 })
  })
})
