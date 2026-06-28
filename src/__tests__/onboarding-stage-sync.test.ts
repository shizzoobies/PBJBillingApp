/**
 * Unit tests for `onboardingStageForSync` — the pure mapping that decides
 * whether (and to which lifecycle stage) a client should move when a stage of
 * its onboarding case advances or completes.
 *
 * This is the authoritative decision function: `toggleChecklistItem` calls it
 * identically on both the Postgres and file backends, then applies the result
 * to the client. So pinning the helper down pins down the sync itself —
 * crucially that it is a strict NO-OP for any normal (non-onboarding) case,
 * which is what keeps ordinary multi-stage cases byte-for-byte unchanged.
 *
 * Import target is `../../db/store.js` (plain JS) which vitest resolves
 * directly; the helper takes plain objects so we never touch pg.
 */
// @ts-expect-error - plain-JS module without type declarations
import { onboardingStageForSync } from '../../db/store.js'
import { describe, expect, it } from 'vitest'

type Item = { id: string; done: boolean }
type Checklist = {
  id: string
  stageIndex?: number
  stageCount?: number
  items: Item[]
  onboardingForClientId?: string
}

function onboardingChecklist(overrides: Partial<Checklist> = {}): Checklist {
  return {
    id: 'check-1',
    stageIndex: 0,
    stageCount: 3,
    items: [{ id: 'i1', done: true }],
    onboardingForClientId: 'client-1',
    ...overrides,
  }
}

describe('onboardingStageForSync — onboarding case advancement', () => {
  it('maps a spawn at stageIndex 0 to "proposal"', () => {
    const checklist = onboardingChecklist({ stageIndex: 0 })
    const spawned = { stageIndex: 0, stageCount: 3 }
    expect(onboardingStageForSync(checklist, spawned)).toBe('proposal')
  })

  it('maps a spawn at stageIndex 1 to "onboarding"', () => {
    const checklist = onboardingChecklist({ stageIndex: 0 })
    const spawned = { stageIndex: 1, stageCount: 3 }
    expect(onboardingStageForSync(checklist, spawned)).toBe('onboarding')
  })

  it('maps a spawn beyond stageIndex 1 to "active" (defensive)', () => {
    const checklist = onboardingChecklist({ stageIndex: 1 })
    const spawned = { stageIndex: 2, stageCount: 3 }
    expect(onboardingStageForSync(checklist, spawned)).toBe('active')
  })

  it('sets "active" when the FINAL stage completes (no spawn, all items done)', () => {
    const checklist = onboardingChecklist({
      stageIndex: 2,
      stageCount: 3,
      items: [{ id: 'i1', done: true }, { id: 'i2', done: true }],
    })
    expect(onboardingStageForSync(checklist, null)).toBe('active')
  })

  it('returns null on a mid-stage toggle that did not advance (no spawn, items not all done)', () => {
    const checklist = onboardingChecklist({
      stageIndex: 1,
      stageCount: 3,
      items: [{ id: 'i1', done: true }, { id: 'i2', done: false }],
    })
    expect(onboardingStageForSync(checklist, null)).toBeNull()
  })

  it('returns null when not the final stage and nothing spawned', () => {
    const checklist = onboardingChecklist({
      stageIndex: 0,
      stageCount: 3,
      items: [{ id: 'i1', done: true }],
    })
    // All items done but a next stage exists — the spawn path (truthy
    // `spawned`) drives the move, so the no-spawn branch must stay null.
    expect(onboardingStageForSync(checklist, null)).toBeNull()
  })
})

describe('onboardingStageForSync — normal cases are never touched', () => {
  it('returns null for a normal case (no onboardingForClientId), even when a stage spawns', () => {
    const normal: Checklist = {
      id: 'check-normal',
      stageIndex: 0,
      stageCount: 3,
      items: [{ id: 'i1', done: true }],
      // no onboardingForClientId
    }
    const spawned = { stageIndex: 1, stageCount: 3 }
    expect(onboardingStageForSync(normal, spawned)).toBeNull()
  })

  it('returns null for a normal case completing its final stage', () => {
    const normal: Checklist = {
      id: 'check-normal',
      stageIndex: 2,
      stageCount: 3,
      items: [{ id: 'i1', done: true }],
    }
    expect(onboardingStageForSync(normal, null)).toBeNull()
  })

  it('returns null when the checklist itself is missing', () => {
    expect(onboardingStageForSync(null, null)).toBeNull()
  })
})
