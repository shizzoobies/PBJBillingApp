import { describe, expect, it } from 'vitest'
import {
  APPROVAL_SECTION_ANCHORS,
  APPROVAL_SECTION_KEYS,
  resolveApprovalSection,
  type ApprovalSection,
} from '../lib/approvalSections'

const none: Record<ApprovalSection, number> = { weekly: 0, queue: 0, locks: 0 }

describe('resolveApprovalSection', () => {
  it('opens the first section when nothing is pending anywhere', () => {
    expect(resolveApprovalSection({ counts: none })).toBe('weekly')
    expect(resolveApprovalSection({})).toBe('weekly')
  })

  it('opens the first section that has pending work', () => {
    expect(resolveApprovalSection({ counts: { ...none, queue: 3 } })).toBe('queue')
    expect(resolveApprovalSection({ counts: { ...none, locks: 2 } })).toBe('locks')
    // Weekly still wins when it also has work — tab order decides ties.
    expect(resolveApprovalSection({ counts: { weekly: 1, queue: 5, locks: 9 } })).toBe('weekly')
  })

  it('lets an explicit click beat the pending-work default', () => {
    // The whole point: picking a quiet tab must not bounce you back to the busy
    // one on the next render.
    expect(
      resolveApprovalSection({ sectionParam: 'locks', counts: { ...none, queue: 4 } }),
    ).toBe('locks')
    expect(
      resolveApprovalSection({ sectionParam: 'weekly', counts: { ...none, queue: 4 } }),
    ).toBe('weekly')
  })

  it('ignores a section param that names nothing', () => {
    expect(resolveApprovalSection({ sectionParam: 'nope', counts: { ...none, queue: 1 } })).toBe(
      'queue',
    )
    expect(resolveApprovalSection({ sectionParam: '', counts: none })).toBe('weekly')
    expect(resolveApprovalSection({ sectionParam: null, counts: none })).toBe('weekly')
  })

  it('follows a hash link to the section it anchors', () => {
    // An old `/time-approvals#timesheet-locks` link must still land somewhere
    // real now that the sections are not all mounted at once.
    expect(
      resolveApprovalSection({ hash: `#${APPROVAL_SECTION_ANCHORS.locks}`, counts: none }),
    ).toBe('locks')
    expect(
      resolveApprovalSection({ hash: APPROVAL_SECTION_ANCHORS.queue, counts: none }),
    ).toBe('queue')
    // A bare section key works too.
    expect(resolveApprovalSection({ hash: '#queue', counts: none })).toBe('queue')
  })

  it('lets the section param beat a hash, and ignores an unrelated hash', () => {
    expect(
      resolveApprovalSection({
        sectionParam: 'weekly',
        hash: `#${APPROVAL_SECTION_ANCHORS.locks}`,
        counts: none,
      }),
    ).toBe('weekly')
    expect(resolveApprovalSection({ hash: '#something-else', counts: { ...none, queue: 1 } })).toBe(
      'queue',
    )
  })

  it('exposes an anchor for every section', () => {
    expect(APPROVAL_SECTION_KEYS).toEqual(['weekly', 'queue', 'locks'])
    for (const key of APPROVAL_SECTION_KEYS) {
      expect(APPROVAL_SECTION_ANCHORS[key]).toBeTruthy()
    }
  })
})
