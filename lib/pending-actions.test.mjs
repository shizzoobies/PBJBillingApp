import { describe, expect, it } from 'vitest'
import { createPendingActionStore } from './pending-actions.js'

const proposal = (n) => ({
  tool: 'assign_client',
  label: 'Assign a client',
  summary: `Proposal ${n}`,
  params: { clientName: 'Clover', bookkeeperName: 'Avery' },
})

describe('createPendingActionStore', () => {
  it('adds and lists proposals per user, oldest first', () => {
    const store = createPendingActionStore()
    const a = store.add('owner', proposal(1), 1000)
    const b = store.add('owner', proposal(2), 2000)
    store.add('someone-else', proposal(3), 2000)
    const list = store.list('owner', 3000)
    expect(list.map((p) => p.id)).toEqual([a.id, b.id])
    expect(list[0].summary).toBe('Proposal 1')
  })

  it('resolve removes exactly one proposal and reports existence', () => {
    const store = createPendingActionStore()
    const a = store.add('owner', proposal(1), 1000)
    expect(store.resolve('owner', a.id, 2000)).toBe(true)
    expect(store.resolve('owner', a.id, 2000)).toBe(false)
    expect(store.list('owner', 2000)).toEqual([])
  })

  it('expires proposals after the TTL', () => {
    const store = createPendingActionStore({ ttlMs: 1000 })
    store.add('owner', proposal(1), 1000)
    expect(store.list('owner', 1999)).toHaveLength(1)
    expect(store.list('owner', 2001)).toHaveLength(0)
  })

  it('caps proposals per user, dropping the oldest', () => {
    const store = createPendingActionStore({ max: 2 })
    store.add('owner', proposal(1), 1000)
    store.add('owner', proposal(2), 1001)
    store.add('owner', proposal(3), 1002)
    const summaries = store.list('owner', 1003).map((p) => p.summary)
    expect(summaries).toEqual(['Proposal 2', 'Proposal 3'])
  })

  it('rejects junk input', () => {
    const store = createPendingActionStore()
    expect(store.add('', proposal(1))).toBeNull()
    expect(store.add('owner', { summary: 'no tool' })).toBeNull()
    expect(store.list('')).toEqual([])
    expect(store.resolve('owner', '')).toBe(false)
  })
})
