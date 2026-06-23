import { describe, expect, it } from 'vitest'
import { itemDeletionKey } from '../lib/utils'

/**
 * Pure-helper tests for the pending item-deletion key. The key uniquely
 * identifies an item / sub-item / sub-sub-item within a checklist so the client
 * can build a Set for fast badge lookup and the server can dedupe requests
 * against the same shape.
 */
describe('itemDeletionKey', () => {
  it('keys a top-level item with empty sub/sub-sub segments', () => {
    expect(itemDeletionKey('cl-1', 'it-1')).toBe('cl-1:it-1::')
  })

  it('keys a sub-item', () => {
    expect(itemDeletionKey('cl-1', 'it-1', 'sub-1')).toBe('cl-1:it-1:sub-1:')
  })

  it('keys a sub-sub-item', () => {
    expect(itemDeletionKey('cl-1', 'it-1', 'sub-1', 'ss-1')).toBe('cl-1:it-1:sub-1:ss-1')
  })

  it('treats null/undefined path parts as absent (same key)', () => {
    expect(itemDeletionKey('cl-1', 'it-1', null, null)).toBe(itemDeletionKey('cl-1', 'it-1'))
    expect(itemDeletionKey('cl-1', 'it-1', undefined, undefined)).toBe(
      itemDeletionKey('cl-1', 'it-1'),
    )
  })

  it('never collides across levels for the same ids', () => {
    const item = itemDeletionKey('cl-1', 'x')
    const sub = itemDeletionKey('cl-1', 'x', 'x')
    const subSub = itemDeletionKey('cl-1', 'x', 'x', 'x')
    expect(new Set([item, sub, subSub]).size).toBe(3)
  })
})
