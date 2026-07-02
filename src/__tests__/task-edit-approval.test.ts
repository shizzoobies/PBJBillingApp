import { describe, expect, it } from 'vitest'
import {
  canEditDirectly,
  resolveTaskApprover,
  summarizeProposedEdit,
} from '../lib/taskEditApproval'

/**
 * Pure-helper tests for task-edit approval routing. These cover approver
 * resolution (creator vs system→owner), the apply-vs-route decision
 * (owner/creator direct; everyone else routes), and the queue summary string.
 */

const owner = { id: 'owner-1', role: 'owner' as const }
const alice = { id: 'user-alice', role: 'employee' as const }
const bob = { id: 'user-bob', role: 'employee' as const }
const users = [owner, alice, bob]

describe('resolveTaskApprover', () => {
  it('routes to the creator when they are a real non-owner user', () => {
    expect(resolveTaskApprover({ createdBy: 'user-alice' }, users)).toBe('user-alice')
  })

  it('routes a system task (no createdBy) to the owner', () => {
    expect(resolveTaskApprover({ createdBy: undefined }, users)).toBe('owner-1')
    expect(resolveTaskApprover({ createdBy: null as unknown as undefined }, users)).toBe('owner-1')
  })

  it('routes to the owner when the creator IS the owner', () => {
    expect(resolveTaskApprover({ createdBy: 'owner-1' }, users)).toBe('owner-1')
  })

  it('routes to the owner when the creator no longer exists', () => {
    expect(resolveTaskApprover({ createdBy: 'ghost' }, users)).toBe('owner-1')
  })
})

describe('canEditDirectly', () => {
  it('lets the owner edit anyone’s task directly', () => {
    expect(canEditDirectly(owner, { createdBy: 'user-alice' })).toBe(true)
  })

  it('lets the creator edit their own task directly', () => {
    expect(canEditDirectly(alice, { createdBy: 'user-alice' })).toBe(true)
  })

  it('routes a non-creator, non-owner edit', () => {
    expect(canEditDirectly(bob, { createdBy: 'user-alice' })).toBe(false)
  })

  it('routes any staff edit of a system task (no creator)', () => {
    expect(canEditDirectly(alice, { createdBy: undefined })).toBe(false)
  })
})

describe('summarizeProposedEdit', () => {
  it('formats a title change', () => {
    expect(summarizeProposedEdit('details', { title: 'B' }, { title: 'A' })).toBe(
      'Title: "A" → "B"',
    )
  })

  it('formats multiple fields joined by a separator', () => {
    const summary = summarizeProposedEdit(
      'details',
      { title: 'B', dueDate: '2026-08-01' },
      { title: 'A', dueDate: '2026-07-01' },
    )
    expect(summary).toBe('Title: "A" → "B"; Due date: "2026-07-01" → "2026-08-01"')
  })

  it('renders empty/absent previous values as an em dash', () => {
    expect(summarizeProposedEdit('details', { assigneeId: 'user-bob' }, {})).toBe(
      'Assignee: — → "user-bob"',
    )
  })

  it('summarizes an added step', () => {
    expect(summarizeProposedEdit('add_item', { title: 'New step' })).toBe('Add step: "New step"')
  })

  it('falls back when no named field changed', () => {
    expect(summarizeProposedEdit('item', {})).toBe('Edit step')
    expect(summarizeProposedEdit('details', {})).toBe('Edit task details')
  })
})
